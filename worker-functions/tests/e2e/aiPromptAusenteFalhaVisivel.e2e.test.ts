/**
 * aiPromptAusenteFalhaVisivel.e2e.test.ts @integration — spec 029 (prompts de IA editáveis),
 * T019a (FR-031).
 *
 * Prova que instrução ausente falha de forma VISÍVEL, sem cair de volta na fonte antiga (a
 * constante `DESCRIPTION_SYSTEM_PROMPT` e o provider do Drive continuam no código até a Fase 6 —
 * princípio VI — então a ausência de fallback precisa ser PROVADA, não presumida).
 *
 * "Ausente" aqui é `is_active = false`, como o texto da tarefa manda. O caminho de geração lê por
 * `AiPromptRepository.findActiveBySlug` (`src/modules/integration/infrastructure/AiPromptRepository.ts`),
 * que faz `SELECT ... WHERE slug = $1 AND is_active = true` — então desmarcar a linha realmente
 * desliga o prompt, e é isso que este teste exercita.
 *
 * (Histórico: até 29/09 o serviço lia por `findBySlug`, SEM filtro por `is_active`, e desativar não
 * tinha efeito nenhum — este teste precisava fazer DELETE para simular ausência. O `findActiveBySlug`
 * foi criado por decisão do Gabriel nessa data, e o teste voltou à desativação.)
 *
 * O `afterAll` restaura a linha por completo (conteúdo + `is_active` + trilha de auditoria), roda
 * incondicionalmente mesmo se a asserção falhar, e é idempotente — restaura tanto de uma
 * desativação quanto de uma linha apagada.
 *
 * COMO O MODELO É INTERCEPTADO: mesmo mecanismo de `aiPromptNoCache.e2e.test.ts` — ver cabeçalho
 * de `tests/e2e/vertexInterceptPreload.js`. Aqui ele cumpre um papel extra: os itens 2 e 3 do
 * aceite ("NÃO 200 com a constante antiga" / "NÃO 200 com prompt vazio") são afirmados contra o
 * CONTEÚDO dos logs do container (zero linhas `[VERTEX-STUB] intercepted call`), não presumidos
 * pelo código HTTP — exatamente o que o aviso da tarefa exige.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { apiContainerLogs } from './helpers/apiContainer';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5529/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

const SLUG = 'VACANCY_DESCRIPTION';

const dockerLogs = apiContainerLogs;

interface CapturedPromptRow {
  id: string;
  slug: string;
  body: string;
  version: number;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface CapturedAuditRow {
  id: string;
  prompt_id: string;
  event_type: string;
  field_name: string;
  changes: unknown;
  actor_user_id: string | null;
  actor_type: string;
  actor_label: string | null;
  trace_id: string | null;
  created_at: string;
}

describe('Instrução ausente falha de forma visível, sem recorrer à fonte antiga (spec 029, T019a — FR-031) @integration', () => {
  const api = createApiClient();
  let asAdmin: StaffAuth;
  let pool: Pool;
  let jobPostingId: string;
  let capturedPrompt: CapturedPromptRow;
  let capturedAudit: CapturedAuditRow[];

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('aiprompt-ausente-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });

    const row = await pool.query<CapturedPromptRow>(
      `SELECT id, slug, body, version, is_active, created_by, updated_by, created_at, updated_at
       FROM ai_prompts WHERE slug = $1`,
      [SLUG],
    );
    if (row.rows.length === 0) {
      throw new Error(`Pré-condição ausente: ai_prompts não tem linha ${SLUG} (migration 487 não aplicada?)`);
    }
    capturedPrompt = row.rows[0];

    // Captura a trilha de auditoria: a desativação não a toca, mas o afterAll reinsere byte a byte
    // (mesmos ids e created_at, `ON CONFLICT DO NOTHING`) para que a restauração também funcione
    // se a linha-mãe tiver sido apagada — `ai_prompt_audit_log.prompt_id` cascateia no DELETE.
    const audit = await pool.query<CapturedAuditRow>(
      `SELECT id, prompt_id, event_type, field_name, changes, actor_user_id, actor_type, actor_label, trace_id, created_at
       FROM ai_prompt_audit_log WHERE prompt_id = $1 ORDER BY created_at ASC`,
      [capturedPrompt.id],
    );
    capturedAudit = audit.rows;

    const jp = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status)
       VALUES ($1, 'T019a e2e — ausente falha visível', 'AR', 'SEARCHING') RETURNING id`,
      [`T019a-JP-${Date.now()}`],
    );
    jobPostingId = jp.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(
      `INSERT INTO ai_prompts (id, slug, body, version, is_active, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         body = EXCLUDED.body, version = EXCLUDED.version, is_active = EXCLUDED.is_active,
         created_by = EXCLUDED.created_by, updated_by = EXCLUDED.updated_by,
         created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [
        capturedPrompt.id,
        capturedPrompt.slug,
        capturedPrompt.body,
        capturedPrompt.version,
        capturedPrompt.is_active,
        capturedPrompt.created_by,
        capturedPrompt.updated_by,
        capturedPrompt.created_at,
        capturedPrompt.updated_at,
      ],
    );
    for (const a of capturedAudit) {
      await pool.query(
        `INSERT INTO ai_prompt_audit_log
           (id, prompt_id, event_type, field_name, changes, actor_user_id, actor_type, actor_label, trace_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id,
          a.prompt_id,
          a.event_type,
          a.field_name,
          a.changes,
          a.actor_user_id,
          a.actor_type,
          a.actor_label,
          a.trace_id,
          a.created_at,
        ],
      );
    }
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]).catch(() => {});
    await pool.end();
  });

  it('com VACANCY_DESCRIPTION desativado: erro explícito, nunca 200, nunca chama o modelo, nomeia o identificador que faltou', async () => {
    await pool.query(`UPDATE ai_prompts SET is_active = false WHERE id = $1`, [capturedPrompt.id]);

    const logsBaseline = dockerLogs();
    const r = await api.post(
      `/api/admin/vacancies/${jobPostingId}/generate-talentum-description`,
      {},
      asAdmin,
    );
    const logsAfter = dockerLogs();
    const delta = logsAfter.slice(logsBaseline.length);

    // 1. Erro explícito, identificável.
    expect(r.status).not.toBe(200);
    expect(r.data.success).toBe(false);
    const errorText = `${r.data.error ?? ''} ${r.data.details ?? ''}`;
    expect(errorText).toMatch(/not found|não encontrad/i);

    // 4. A mensagem nomeia o identificador que faltou.
    expect(errorText).toContain('VACANCY_DESCRIPTION');

    // 2. NÃO 200 com o texto da constante antiga — afirmado contra o CONTEÚDO, não presumido pelo
    // HTTP status: zero linhas de interceptação provam que o modelo nunca foi chamado, logo a
    // constante antiga (que só chegaria a algum lugar DENTRO de um systemInstruction enviado ao
    // modelo) não pôde ter sido usada em lugar nenhum.
    expect(r.status).not.toBe(200);
    expect(delta).not.toContain('[VERTEX-STUB] intercepted call');

    // 3. NÃO 200 com prompt vazio — mesma prova: zero chamadas ao stub cobre tanto "usou a
    // constante antiga" quanto "usou um systemInstruction vazio", porque as duas exigiriam que a
    // chamada ao modelo tivesse acontecido, e ela não aconteceu.
    expect(delta).not.toContain('[VERTEX-STUB] systemInstruction=');

    // Nada foi persistido: a falha aconteceu ANTES do save em job_postings.talentum_description.
    const saved = await pool.query<{ talentum_description: string | null }>(
      `SELECT talentum_description FROM job_postings WHERE id = $1`,
      [jobPostingId],
    );
    expect(saved.rows[0].talentum_description).toBeNull();
  });
});
