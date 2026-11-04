/**
 * aiPromptPreviewNaoGrava.e2e.test.ts @integration — spec 029, T031.
 *
 * Prova, com banco de verdade, que o PREVIEW de prompt de IA não grava nada. Conta as linhas
 * (e um hash do conteúdo) das SEIS tabelas que os caminhos reais tocam, ANTES e DEPOIS de três
 * chamadas ao preview — uma por slug — e exige que tudo fique idêntico.
 *
 * Por que hash além da contagem: `job_postings` recebe UPDATE (`SET talentum_description`, em
 * TalentumDescriptionService.generateDescription) e as tabelas de prescreening são gravadas por
 * DELETE+INSERT (VacancyTalentumController.savePrescreeningConfig). Contar linhas NÃO detecta
 * nenhum dos dois: seria instrumento morto. Por isso cada tabela leva `count(*)` + `md5` do texto
 * de todas as linhas, e `job_postings` leva, em separado, o VALOR de `talentum_description` do caso.
 * Um teste de controle positivo (abaixo) prova que o instrumento enxerga UPDATE, INSERT e
 * DELETE+INSERT de mesma cardinalidade — se ele parar de enxergar, este arquivo reprova.
 *
 * O QUE EXERCITA: o CASO DE USO (`PreviewAiPromptUseCase`) contra o banco real — a rota HTTP é a
 * T033. O use case roda NESTE processo (jest), não dentro do container da API; logo o preload
 * `vertexInterceptPreload.js` (que só vale dentro do container) NÃO cobre este caminho. A fronteira
 * do modelo é dublada aqui com `jest.mock('vertex-gemini')`: nenhuma chamada ao Vertex/Gemini sai.
 * Rede de segurança extra: `global.fetch` é trocado por um que LANÇA para qualquer host Google.
 *
 * A stack (postgres + api) precisa estar de pé: `setup.ts` espera a API, e o container da API é
 * resolvido por `helpers/apiContainer.ts` (sem nome fixo; falha alto se não achar).
 *
 * LIMPEZA: só o que este teste semeou (por id), no `afterAll`, com try/finally — nunca por critério
 * amplo, e nunca nas linhas semeadas pela migration de `ai_prompts`.
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5529/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

// Dublê da fronteira do modelo (hoisted pelo jest). Toda chamada vira resposta sintética.
const mockGenerateContentVertex = jest.fn();
jest.mock('../../src/modules/integration/infrastructure/vertex-gemini', () => ({
  generateContentVertex: (...args: unknown[]) => mockGenerateContentVertex(...args),
}));

import { PreviewAiPromptUseCase } from '../../src/modules/integration/application/PreviewAiPromptUseCase';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { resolveApiContainer, apiContainerLogs } from './helpers/apiContainer';

const TABLES = [
  'ai_prompts',
  'ai_prompt_audit_log',
  'job_postings',
  'job_posting_audit_log',
  'job_posting_prescreening_questions',
  'job_posting_prescreening_faq',
] as const;
type Table = (typeof TABLES)[number];
type Snapshot = Record<Table, { n: number; h: string }>;

const SEED_TALENTUM_DESCRIPTION = 'T031-TALENTUM-DESCRIPTION-ORIGINAL — não pode mudar com o preview';

function stubModelResponse(text: string) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }) };
}

const PRESCREENING_JSON = JSON.stringify({
  vacancy: {
    title: 'T031', case_number: 1, required_professions: ['AT'], required_sex: 'BOTH',
    age_range_min: 20, age_range_max: 60, required_experience: 'sem exigência',
    worker_attributes: 'atributos', schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    work_schedule: 'part-time', providers_needed: 1, salary_text: 'a combinar', payment_day: '5',
    daily_obs: null, status: 'SEARCHING',
  },
  prescreening: {
    questions: [{
      question: 'Pergunta sintética?', responseType: ['text', 'audio'], desiredResponse: 'resposta',
      weight: 5, required: true, analyzed: true, earlyStoppage: false,
    }],
    faq: [{ question: 'FAQ sintética?', answer: 'Resposta sintética.' }],
  },
});

describe('Preview de prompt de IA não grava nada — 6 tabelas, banco real (spec 029, T031) @integration', () => {
  let pool: Pool;
  let realFetch: typeof global.fetch;
  let jobPostingId: string;
  let seededQuestionId: string;
  let seededFaqId: string;
  let seededJpAuditId: string;
  let seededPromptAuditId: string | null = null;

  async function snapshot(): Promise<Snapshot> {
    const out = {} as Snapshot;
    for (const t of TABLES) {
      const r = await pool.query<{ n: number; h: string }>(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
      );
      out[t] = r.rows[0];
    }
    return out;
  }

  async function talentumDescription(): Promise<string | null> {
    const r = await pool.query<{ talentum_description: string | null }>(
      `SELECT talentum_description FROM job_postings WHERE id = $1`,
      [jobPostingId],
    );
    return r.rows[0]?.talentum_description ?? null;
  }

  beforeAll(async () => {
    // Falha alto: sem a stack (e sem o preload ativo nela) não há prova de que o ambiente é o esperado.
    const container = resolveApiContainer();
    expect(container).toBeTruthy();
    expect(apiContainerLogs()).toContain('[VERTEX-STUB] preload ativo');

    realFetch = global.fetch;
    global.fetch = (async (url: unknown) => {
      const u = typeof url === 'string' ? url : String((url as { url?: string })?.url ?? url);
      if (/googleapis\.com|google\.internal|169\.254\.169\.254/.test(u)) {
        throw new Error(`[T031] chamada de rede ao Google BLOQUEADA no teste: ${u}`);
      }
      return realFetch(url as never);
    }) as typeof global.fetch;

    pool = new Pool({ connectionString: DATABASE_URL });

    const seeded = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_prompts`);
    if (seeded.rows[0].n < 3) {
      throw new Error(`Pré-condição ausente: ai_prompts tem ${seeded.rows[0].n} linhas (migration 487 não aplicada?)`);
    }

    const jp = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status, talentum_description)
       VALUES ($1, 'T031 e2e — preview não grava', 'AR', 'SEARCHING', $2) RETURNING id`,
      [`T031-JP-${Date.now()}`, SEED_TALENTUM_DESCRIPTION],
    );
    jobPostingId = jp.rows[0].id;

    // Estado não-vazio nas tabelas filhas, para que "contagem zero" nunca seja o que está sendo comparado.
    seededQuestionId = (await pool.query<{ id: string }>(
      `INSERT INTO job_posting_prescreening_questions (job_posting_id, question_order, question, desired_response, weight)
       VALUES ($1, 1, 'T031 pergunta semeada', 'T031 resposta desejada', 5) RETURNING id`,
      [jobPostingId],
    )).rows[0].id;
    seededFaqId = (await pool.query<{ id: string }>(
      `INSERT INTO job_posting_prescreening_faq (job_posting_id, faq_order, question, answer)
       VALUES ($1, 1, 'T031 faq semeada', 'T031 resposta semeada') RETURNING id`,
      [jobPostingId],
    )).rows[0].id;
    seededJpAuditId = (await pool.query<{ id: string }>(
      `INSERT INTO job_posting_audit_log (job_posting_id, event_type, field_name, actor_type, actor_label)
       VALUES ($1, 'UPDATED', 'T031', 'SYSTEM', 'T031-seed') RETURNING id`,
      [jobPostingId],
    )).rows[0].id;
    const anyPrompt = await pool.query<{ id: string }>(`SELECT id FROM ai_prompts ORDER BY slug LIMIT 1`);
    seededPromptAuditId = (await pool.query<{ id: string }>(
      `INSERT INTO ai_prompt_audit_log (prompt_id, event_type, actor_type, actor_label)
       VALUES ($1, 'UPDATED', 'SYSTEM', 'T031-seed') RETURNING id`,
      [anyPrompt.rows[0].id],
    )).rows[0].id;
  });

  afterAll(async () => {
    // Incondicional, try/finally: só o que ESTE teste semeou, por id; o pool fecha mesmo se algo falhar.
    try {
      if (global.fetch && realFetch) global.fetch = realFetch;
      if (pool) {
        try {
          if (seededPromptAuditId) {
            await pool.query(`DELETE FROM ai_prompt_audit_log WHERE id = $1`, [seededPromptAuditId]);
          }
          if (seededJpAuditId) await pool.query(`DELETE FROM job_posting_audit_log WHERE id = $1`, [seededJpAuditId]);
          if (seededQuestionId) await pool.query(`DELETE FROM job_posting_prescreening_questions WHERE id = $1`, [seededQuestionId]);
          if (seededFaqId) await pool.query(`DELETE FROM job_posting_prescreening_faq WHERE id = $1`, [seededFaqId]);
        } finally {
          if (jobPostingId) await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]);
        }
      }
    } finally {
      if (pool) await pool.end();
      await DatabaseConnection.getInstance().getPool().end().catch(() => {});
    }
  });

  beforeEach(() => {
    mockGenerateContentVertex.mockReset();
  });

  it('CONTROLE POSITIVO: o instrumento enxerga UPDATE, INSERT e DELETE+INSERT de mesma cardinalidade (senão a prova abaixo é vazia)', async () => {
    const base = await snapshot();
    expect(await talentumDescription()).toBe(SEED_TALENTUM_DESCRIPTION);

    // UPDATE em job_postings: a contagem não muda, o hash e o valor têm de mudar.
    await pool.query(`UPDATE job_postings SET talentum_description = $2 WHERE id = $1`, [jobPostingId, 'T031 mutado']);
    const afterUpdate = await snapshot();
    expect(afterUpdate.job_postings.n).toBe(base.job_postings.n);
    expect(afterUpdate.job_postings.h).not.toBe(base.job_postings.h);
    expect(await talentumDescription()).toBe('T031 mutado');
    await pool.query(`UPDATE job_postings SET talentum_description = $2 WHERE id = $1`, [jobPostingId, SEED_TALENTUM_DESCRIPTION]);

    // DELETE+INSERT (o que savePrescreeningConfig faz): mesma contagem, conteúdo outro → hash muda.
    await pool.query(`DELETE FROM job_posting_prescreening_faq WHERE id = $1`, [seededFaqId]);
    seededFaqId = (await pool.query<{ id: string }>(
      `INSERT INTO job_posting_prescreening_faq (job_posting_id, faq_order, question, answer)
       VALUES ($1, 1, 'T031 faq REGRAVADA', 'T031 outra resposta') RETURNING id`,
      [jobPostingId],
    )).rows[0].id;
    const afterReplace = await snapshot();
    expect(afterReplace.job_posting_prescreening_faq.n).toBe(base.job_posting_prescreening_faq.n);
    expect(afterReplace.job_posting_prescreening_faq.h).not.toBe(base.job_posting_prescreening_faq.h);

    // INSERT: a contagem sobe.
    const extra = await pool.query<{ id: string }>(
      `INSERT INTO job_posting_audit_log (job_posting_id, event_type, field_name, actor_type, actor_label)
       VALUES ($1, 'UPDATED', 'T031-extra', 'SYSTEM', 'T031-seed') RETURNING id`,
      [jobPostingId],
    );
    const afterInsert = await snapshot();
    expect(afterInsert.job_posting_audit_log.n).toBe(base.job_posting_audit_log.n + 1);
    await pool.query(`DELETE FROM job_posting_audit_log WHERE id = $1`, [extra.rows[0].id]);

    // Volta ao estado-base do teste seguinte: restaura a FAQ original.
    await pool.query(`DELETE FROM job_posting_prescreening_faq WHERE id = $1`, [seededFaqId]);
    seededFaqId = (await pool.query<{ id: string }>(
      `INSERT INTO job_posting_prescreening_faq (job_posting_id, faq_order, question, answer)
       VALUES ($1, 1, 'T031 faq semeada', 'T031 resposta semeada') RETURNING id`,
      [jobPostingId],
    )).rows[0].id;
  });

  it('três chamadas ao preview (VACANCY_DESCRIPTION, PRESCREENING_AT, PRESCREENING_CAREGIVER) deixam as 6 tabelas e o talentum_description IDÊNTICOS', async () => {
    // Pré-condições afirmadas: estado não-vazio e valor conhecido (contagem zero seria "não medi").
    const before = await snapshot();
    const descBefore = await talentumDescription();
    expect(descBefore).toBe(SEED_TALENTUM_DESCRIPTION);
    expect(before.ai_prompts.n).toBeGreaterThanOrEqual(3);
    expect(before.ai_prompt_audit_log.n).toBeGreaterThanOrEqual(1);
    expect(before.job_postings.n).toBeGreaterThanOrEqual(1);
    expect(before.job_posting_audit_log.n).toBeGreaterThanOrEqual(1);
    expect(before.job_posting_prescreening_questions.n).toBeGreaterThanOrEqual(1);
    expect(before.job_posting_prescreening_faq.n).toBeGreaterThanOrEqual(1);

    mockGenerateContentVertex.mockImplementation(async (_model: string, body: { systemInstruction?: { parts?: Array<{ text?: string }> } }) => {
      const sys = body.systemInstruction?.parts?.[0]?.text ?? '';
      // Distingue pelo marcador do corpo em edição: descrição usa o schema propuesta/perfil; o resto usa o de prescreening.
      return sys.includes('T031-BODY-VACANCY')
        ? stubModelResponse(JSON.stringify({ propuesta: 'Propuesta sintética.', perfilProfesional: 'Perfil sintético.' }))
        : stubModelResponse(PRESCREENING_JSON);
    });

    const useCase = new PreviewAiPromptUseCase();
    const logsBefore = apiContainerLogs();

    const vacancy = await useCase.execute({ slug: 'VACANCY_DESCRIPTION', body: 'T031-BODY-VACANCY texto em edição', jobPostingId });
    const at = await useCase.execute({ slug: 'PRESCREENING_AT', body: 'T031-BODY-AT texto em edição', jobPostingId });
    const caregiver = await useCase.execute({ slug: 'PRESCREENING_CAREGIVER', body: 'T031-BODY-CAREGIVER texto em edição', jobPostingId });

    // As três chamadas de fato percorreram o caminho até o modelo (dublê), e só uma vez cada.
    expect(vacancy.generated).toContain('Propuesta sintética.');
    expect(at.generated).toContain('Pergunta sintética?');
    expect(caregiver.generated).toContain('Pergunta sintética?');
    expect(mockGenerateContentVertex).toHaveBeenCalledTimes(3);
    const systemTexts = mockGenerateContentVertex.mock.calls.map((c) => (c[1] as any).systemInstruction.parts[0].text as string);
    expect(systemTexts[0]).toContain('T031-BODY-VACANCY');
    expect(systemTexts[1]).toContain('T031-BODY-AT');
    expect(systemTexts[2]).toContain('T031-BODY-CAREGIVER');

    // Nenhuma interceptação nova no container da API (o preview roda fora dele, só o dublê local foi tocado).
    expect(apiContainerLogs().slice(logsBefore.length)).not.toContain('[VERTEX-STUB] intercepted call');

    const after = await snapshot();
    const descAfter = await talentumDescription();

    // eslint-disable-next-line no-console
    console.log(
      '[T031] CONTAGENS ANTES → DEPOIS\n' +
        TABLES.map((t) => `  ${t}: ${before[t].n} → ${after[t].n}  (hash ${before[t].h} → ${after[t].h})`).join('\n') +
        `\n[T031] talentum_description ANTES : ${JSON.stringify(descBefore)}` +
        `\n[T031] talentum_description DEPOIS: ${JSON.stringify(descAfter)}`,
    );

    expect(descAfter).toBe(descBefore);
    for (const t of TABLES) {
      expect({ table: t, ...after[t] }).toEqual({ table: t, ...before[t] });
    }
  });
});
