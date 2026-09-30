/**
 * aiPromptSimulateVacancy.e2e.test.ts @integration — spec 029, T071.
 *
 * API REAL + Postgres REAL, sem mock de código: `POST /api/admin/ai-prompts/simulate-vacancy`
 * roda a descrição e o prescreening de uma vaga com os prompts em edição e devolve a ESTRUTURA.
 * A única fronteira trocada é o Vertex, pelo preload `vertexInterceptPreload.js` DENTRO do container
 * da API (mesmo canal dos demais e2e da spec; nunca chama o modelo de verdade, custo zero).
 *
 * O QUE PROVA
 *   1. O PAR devolvido: `{success:true, data:{description, prescreening:{questions,faq}, workerType, usedSlugs}}`,
 *      sem `vacancy{}`, e o envelope `success` que o `AdminApiService.request()` exige.
 *   2. A escolha do prescreening pela VAGA (AT × CUIDADOR), e que o corpo do outro slug é IGNORADO —
 *      lido no log do stub, que registra o systemInstruction de cada chamada ao "modelo".
 *   3. O modelo é o da produção (`GEMINI_MODEL_FAST ?? gemini-2.5-flash`), lido na URL interceptada.
 *   4. NÃO ESCREVE: fotografia ANTES × DEPOIS de 7 tabelas (contagem + md5 do conteúdo) e da LINHA
 *      INTEIRA da vaga (`to_jsonb`). CONTROLE POSITIVO: o mesmo instrumento tem de ACUSAR um UPDATE,
 *      um DELETE+INSERT de mesma cardinalidade e um INSERT — senão "nada mudou" pode ser "não olhei".
 *
 * LIMPEZA: só o que este teste semeou, por id, em try/finally; nunca nas linhas de `ai_prompts`.
 */
import { Pool } from 'pg';
import { execSync } from 'child_process';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { resolveApiContainer, apiContainerLogs } from './helpers/apiContainer';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5529/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

const SIMULATE = '/api/admin/ai-prompts/simulate-vacancy';

const TABLES = [
  'ai_prompts',
  'ai_prompt_audit_log',
  'job_postings',
  'job_posting_audit_log',
  'job_posting_prescreening_questions',
  'job_posting_prescreening_faq',
] as const;
type Table = (typeof TABLES)[number];
type Fotografia = { tabelas: Record<Table, { n: number; h: string }>; vaga: Record<string, unknown> };

const SEED_DESC = 'T071-TALENTUM-DESCRIPTION-ORIGINAL — a simulação não pode mudar isto';

/** Modelo que a produção usa: o do ambiente do container, senão o flash. */
function modeloEsperadoNoContainer(): string {
  let fast = '';
  try {
    fast = execSync(`docker exec ${resolveApiContainer()} printenv GEMINI_MODEL_FAST`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    fast = ''; // printenv sai 1 quando a variável não existe
  }
  return fast || 'gemini-2.5-flash';
}

describe('Simular vacante com os prompts em edição — API real, sem escrever (spec 029, T071) @integration', () => {
  const api = createApiClient();
  let asAdmin: StaffAuth;
  let asRecruiter: StaffAuth;
  let pool: Pool;
  let jobAt: string;
  let jobCaregiver: string;
  const seededQuestions: string[] = [];
  const seededFaqs: string[] = [];
  const seededJpAudits: string[] = [];
  let seededPromptAuditId: string | null = null;

  async function semearVaga(profissoes: string[], rotulo: string): Promise<string> {
    const jp = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status, talentum_description, required_professions)
       VALUES ($1, 'T071 e2e — simulação não grava', 'AR', 'SEARCHING', $2, $3) RETURNING id`,
      [`T071-${rotulo}-${Date.now()}`, SEED_DESC, profissoes],
    );
    const id = jp.rows[0].id;
    seededQuestions.push((await pool.query<{ id: string }>(
      `INSERT INTO job_posting_prescreening_questions (job_posting_id, question_order, question, desired_response, weight)
       VALUES ($1, 1, 'T071 pergunta semeada', 'T071 resposta desejada', 5) RETURNING id`, [id])).rows[0].id);
    seededFaqs.push((await pool.query<{ id: string }>(
      `INSERT INTO job_posting_prescreening_faq (job_posting_id, faq_order, question, answer)
       VALUES ($1, 1, 'T071 faq semeada', 'T071 resposta semeada') RETURNING id`, [id])).rows[0].id);
    seededJpAudits.push((await pool.query<{ id: string }>(
      `INSERT INTO job_posting_audit_log (job_posting_id, event_type, field_name, actor_type, actor_label)
       VALUES ($1, 'UPDATED', 'T071', 'SYSTEM', 'T071-seed') RETURNING id`, [id])).rows[0].id);
    return id;
  }

  async function fotografar(jobId: string): Promise<Fotografia> {
    const tabelas = {} as Fotografia['tabelas'];
    for (const t of TABLES) {
      const r = await pool.query<{ n: number; h: string }>(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
      );
      tabelas[t] = r.rows[0];
    }
    const vaga = (await pool.query<{ r: Record<string, unknown> }>(`SELECT to_jsonb(j) AS r FROM job_postings j WHERE id = $1`, [jobId])).rows[0].r;
    return { tabelas, vaga };
  }

  /** O instrumento: diz o que DIFERE entre duas fotografias (vazio = idênticas). */
  function diferencas(a: Fotografia, b: Fotografia): string[] {
    const out: string[] = [];
    for (const t of TABLES) {
      if (a.tabelas[t].n !== b.tabelas[t].n || a.tabelas[t].h !== b.tabelas[t].h) out.push(`tabela:${t}`);
    }
    for (const k of Object.keys({ ...a.vaga, ...b.vaga })) {
      if (JSON.stringify(a.vaga[k]) !== JSON.stringify(b.vaga[k])) out.push(`vaga.${k}`);
    }
    return out;
  }

  beforeAll(async () => {
    // Falha alto: sem o preload ativo o teste poderia alcançar o Vertex de verdade.
    resolveApiContainer();
    expect(apiContainerLogs()).toContain('[VERTEX-STUB] preload ativo');

    await waitForBackend(api);
    asAdmin = await staffAuth('aiprompt-sim-admin', 'admin', 'AR');
    asRecruiter = await staffAuth('aiprompt-sim-recruiter', 'recruiter', 'AR');
    pool = new Pool({ connectionString: DATABASE_URL });

    const n = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_prompts`)).rows[0].n;
    if (n < 3) throw new Error(`Pré-condição ausente: ai_prompts tem ${n} linhas (migration de semeadura não aplicada?)`);

    jobAt = await semearVaga(['AT'], 'AT');
    jobCaregiver = await semearVaga(['CUIDADOR'], 'CUIDADOR');
    const anyPrompt = await pool.query<{ id: string }>(`SELECT id FROM ai_prompts ORDER BY slug LIMIT 1`);
    seededPromptAuditId = (await pool.query<{ id: string }>(
      `INSERT INTO ai_prompt_audit_log (prompt_id, event_type, actor_type, actor_label)
       VALUES ($1, 'UPDATED', 'SYSTEM', 'T071-seed') RETURNING id`, [anyPrompt.rows[0].id])).rows[0].id;
  });

  afterAll(async () => {
    try {
      if (pool) {
        try {
          if (seededPromptAuditId) await pool.query(`DELETE FROM ai_prompt_audit_log WHERE id = $1`, [seededPromptAuditId]);
          if (seededJpAudits.length) await pool.query(`DELETE FROM job_posting_audit_log WHERE id = ANY($1::uuid[])`, [seededJpAudits]);
          if (seededQuestions.length) await pool.query(`DELETE FROM job_posting_prescreening_questions WHERE id = ANY($1::uuid[])`, [seededQuestions]);
          if (seededFaqs.length) await pool.query(`DELETE FROM job_posting_prescreening_faq WHERE id = ANY($1::uuid[])`, [seededFaqs]);
        } finally {
          const ids = [jobAt, jobCaregiver].filter(Boolean);
          if (ids.length) await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [ids]);
        }
      }
    } finally {
      if (pool) await pool.end();
    }
  });

  it('CONTROLE POSITIVO: o instrumento ACUSA UPDATE, DELETE+INSERT de mesma cardinalidade e INSERT (senão "nada mudou" é vácuo)', async () => {
    const base = await fotografar(jobAt);
    expect(diferencas(base, await fotografar(jobAt))).toEqual([]); // duas fotos seguidas: idênticas

    try {
      await pool.query(`UPDATE job_postings SET talentum_description = 'T071 mutado' WHERE id = $1`, [jobAt]);
      const d1 = diferencas(base, await fotografar(jobAt));
      expect(d1).toContain('vaga.talentum_description');
      expect(d1).toContain('tabela:job_postings');
    } finally {
      await pool.query(`UPDATE job_postings SET talentum_description = $2 WHERE id = $1`, [jobAt, SEED_DESC]);
    }

    let faqId = seededFaqs[0];
    try {
      await pool.query(`DELETE FROM job_posting_prescreening_faq WHERE id = $1`, [faqId]);
      faqId = (await pool.query<{ id: string }>(
        `INSERT INTO job_posting_prescreening_faq (job_posting_id, faq_order, question, answer)
         VALUES ($1, 1, 'T071 faq REGRAVADA', 'outra') RETURNING id`, [jobAt])).rows[0].id;
      seededFaqs[0] = faqId;
      const foto = await fotografar(jobAt);
      expect(foto.tabelas.job_posting_prescreening_faq.n).toBe(base.tabelas.job_posting_prescreening_faq.n);
      expect(diferencas(base, foto)).toContain('tabela:job_posting_prescreening_faq');
    } finally {
      await pool.query(`DELETE FROM job_posting_prescreening_faq WHERE id = $1`, [faqId]);
      seededFaqs[0] = (await pool.query<{ id: string }>(
        `INSERT INTO job_posting_prescreening_faq (job_posting_id, faq_order, question, answer)
         VALUES ($1, 1, 'T071 faq semeada', 'T071 resposta semeada') RETURNING id`, [jobAt])).rows[0].id;
    }

    let extra: string | null = null;
    try {
      extra = (await pool.query<{ id: string }>(
        `INSERT INTO job_posting_audit_log (job_posting_id, event_type, field_name, actor_type, actor_label)
         VALUES ($1, 'UPDATED', 'T071-extra', 'SYSTEM', 'T071-seed') RETURNING id`, [jobAt])).rows[0].id;
      expect(diferencas(base, await fotografar(jobAt))).toContain('tabela:job_posting_audit_log');
    } finally {
      if (extra) await pool.query(`DELETE FROM job_posting_audit_log WHERE id = $1`, [extra]);
    }

    // Restaurado: confere contra a fotografia de entrada. Dois resíduos INEVITÁVEIS do próprio controle
    // positivo, e só eles: `job_postings.updated_at` (o UPDATE de propósito dispara o gatilho de
    // updated_at) e a FAQ recriada com id novo. O VALOR restaurado de talentum_description é conferido.
    const restaurada = await fotografar(jobAt);
    expect(restaurada.vaga.talentum_description).toBe(base.vaga.talentum_description);
    const d = diferencas(base, restaurada).filter(
      (x) => x !== 'vaga.updated_at' && x !== 'tabela:job_postings' && x !== 'tabela:job_posting_prescreening_faq',
    );
    expect(d).toEqual([]);
  });

  it('vaga AT: 200 com envelope success, estrutura sem vacancy{}, e NADA escrito (7 tabelas + linha inteira da vaga)', async () => {
    const before = await fotografar(jobAt);
    expect(before.tabelas.ai_prompts.n).toBeGreaterThanOrEqual(3);
    expect(before.tabelas.job_posting_prescreening_questions.n).toBeGreaterThanOrEqual(1);
    expect(before.vaga.talentum_description).toBe(SEED_DESC);
    const logsBefore = apiContainerLogs();

    const r = await api.post(
      SIMULATE,
      { jobPostingId: jobAt, bodies: { VACANCY_DESCRIPTION: 'T071-EDIT-VD texto em edição', PRESCREENING_AT: 'T071-EDIT-AT texto em edição', PRESCREENING_CAREGIVER: 'T071-EDIT-CG texto em edição' } },
      asAdmin,
    );

    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true); // a armadilha nº 1: sem isto o AdminApiService.request() lança
    expect(Object.keys(r.data.data).sort()).toEqual(['description', 'prescreening', 'usedSlugs', 'workerType']);
    expect(r.data.data.workerType).toBe('AT');
    expect(r.data.data.usedSlugs).toEqual(['VACANCY_DESCRIPTION', 'PRESCREENING_AT']);
    expect(typeof r.data.data.description).toBe('string');
    expect(r.data.data.description).toContain('stub e2e T019/T019a'); // veio do "modelo" (stub), não inventado
    expect(r.data.data.prescreening.questions[0].question).toContain('stub e2e T071');
    expect(r.data.data.prescreening.faq[0].question).toContain('stub e2e T071');
    expect(JSON.stringify(r.data)).not.toContain('"vacancy"');

    // O que chegou ao "modelo": os dois prompts em edição do caso AT; o de CUIDADOR ficou de fora.
    const novos = apiContainerLogs().slice(logsBefore.length);
    const chamadas = novos.split('\n').filter((l) => l.includes('intercepted call'));
    expect(chamadas).toHaveLength(2);
    expect(novos).toContain('T071-EDIT-VD');
    expect(novos).toContain('T071-EDIT-AT');
    expect(novos).not.toContain('T071-EDIT-CG');
    // Mesmo modelo da produção nas duas chamadas.
    const modelo = modeloEsperadoNoContainer();
    for (const c of chamadas) expect(c).toContain(`/models/${modelo}:generateContent`);

    const after = await fotografar(jobAt);
    // eslint-disable-next-line no-console
    console.log(
      '[T071] ANTES → DEPOIS\n' + TABLES.map((t) => `  ${t}: ${before.tabelas[t].n} → ${after.tabelas[t].n} (hash ${before.tabelas[t].h} → ${after.tabelas[t].h})`).join('\n') +
        `\n[T071] diferenças: ${JSON.stringify(diferencas(before, after))}`,
    );
    expect(diferencas(before, after)).toEqual([]);
    expect(after.vaga).toEqual(before.vaga);
  });

  it('vaga CUIDADOR: prescreening CAREGIVER pela VAGA; o corpo de PRESCREENING_AT recebido é ignorado; nada escrito', async () => {
    const before = await fotografar(jobCaregiver);
    const logsBefore = apiContainerLogs();

    const r = await api.post(
      SIMULATE,
      { jobPostingId: jobCaregiver, bodies: { PRESCREENING_AT: 'T071-EDIT-AT texto em edição', PRESCREENING_CAREGIVER: 'T071-EDIT-CG texto em edição' } },
      asAdmin,
    );

    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(r.data.data.workerType).toBe('CUIDADOR');
    expect(r.data.data.usedSlugs).toEqual(['VACANCY_DESCRIPTION', 'PRESCREENING_CAREGIVER']);

    const novos = apiContainerLogs().slice(logsBefore.length);
    expect(novos.split('\n').filter((l) => l.includes('intercepted call'))).toHaveLength(2);
    expect(novos).toContain('T071-EDIT-CG');
    expect(novos).not.toContain('T071-EDIT-AT');

    expect(diferencas(before, await fotografar(jobCaregiver))).toEqual([]);
  });

  it('sem corpos: usa os prompts salvos (a tabela) e ainda assim não escreve', async () => {
    const before = await fotografar(jobAt);
    const r = await api.post(SIMULATE, { jobPostingId: jobAt }, asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(r.data.data.usedSlugs).toEqual(['VACANCY_DESCRIPTION', 'PRESCREENING_AT']);
    expect(diferencas(before, await fotografar(jobAt))).toEqual([]);
  });

  it('403 para quem não é admin; 404 para caso inexistente; 400 para corpo inválido — e nada é escrito', async () => {
    const before = await fotografar(jobAt);
    expect((await api.post(SIMULATE, { jobPostingId: jobAt }, asRecruiter)).status).toBe(403);
    const nf = await api.post(SIMULATE, { jobPostingId: '00000000-0000-4000-8000-000000000071' }, asAdmin);
    expect(nf.status).toBe(404);
    expect(nf.data).toEqual({ success: false, error: 'caso_nao_encontrado' });
    expect((await api.post(SIMULATE, { jobPostingId: 'nao-e-uuid' }, asAdmin)).status).toBe(400);
    expect((await api.post(SIMULATE, { jobPostingId: jobAt, bodies: { PRESCREENING_AT: '   ' } }, asAdmin)).status).toBe(400);
    expect((await api.post(SIMULATE, { jobPostingId: jobAt, bodies: { OUTRO: 'x' } }, asAdmin)).status).toBe(400);
    expect(diferencas(before, await fotografar(jobAt))).toEqual([]);
  });
});
