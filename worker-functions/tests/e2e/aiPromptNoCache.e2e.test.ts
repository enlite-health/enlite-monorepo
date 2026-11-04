/**
 * aiPromptNoCache.e2e.test.ts @integration — spec 029 (prompts de IA editáveis), T019.
 *
 * Prova que `TalentumDescriptionService` NÃO cacheia `ai_prompts.body` em memória: uma alteração
 * na tabela vale já na PRÓXIMA geração, no MESMO processo da API — sem reiniciar o container.
 *
 * Estrutura exigida pelo aceite (T019, tasks.md): UMA geração ANTES da alteração seguinte, prova
 * que o conteúdo mudou entre as duas. Por isso o teste faz DUAS chamadas ao endpoint real
 * (`POST /api/admin/vacancies/:id/generate-talentum-description`), com uma alteração direta na
 * tabela entre elas — uma única geração depois da troca não distinguiria "leu de novo" de "sempre
 * foi assim".
 *
 * COMO O MODELO É INTERCEPTADO (leia primeiro `tests/e2e/vertexInterceptPreload.js`):
 * `vertex-gemini.ts` não tem NENHUMA env var para trocar o host do Vertex (hardcoded
 * `aiplatform.googleapis.com`) — diferente do Periskope/Axonico/Talentum, que já têm `*_BASE_URL`.
 * Por isso a interceptação acontece DENTRO do container da API, via
 * `NODE_OPTIONS=--require=/app/vertexInterceptPreload.js`, montado pelo `docker-compose.test.yml`
 * VERSIONADO (antes vivia num override fora do git, e por isso no CI a interceptação não existia
 * — ver o comentário do volume lá): esse preload substitui `google-auth-library`.GoogleAuth (nunca toca o metadata server
 * real) e `global.fetch` para qualquer URL `aiplatform.googleapis.com` (nunca sai à rede — uma
 * resposta sintética é devolvida na hora, construída a partir do próprio `systemInstruction`
 * recebido). Cada interceptação é logada com o prefixo `[VERTEX-STUB]`, visível via
 * `docker logs <container da API>` (resolvido por `helpers/apiContainer.ts`, sem nome fixo — o
 * nome muda com o projeto do compose) — é isso que este teste lê para provar o que foi "enviado ao
 * modelo": não há outro jeito de ler o `systemInstruction` de fora do processo da API sem alterar
 * `src/` (proibido nesta tarefa).
 *
 * A tabela é restaurada ao valor original no `afterAll`, incondicionalmente (roda mesmo se a
 * asserção falhar) — `scripts/conferir-seed-prompt.ts VACANCY_DESCRIPTION` deve voltar a dizer
 * `IGUAIS` depois deste arquivo rodar.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { apiContainerLogs } from './helpers/apiContainer';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5529/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

const SLUG = 'VACANCY_DESCRIPTION';

/** `docker logs` do container da API — é o único jeito de ver o que o preload interceptou (o
 *  processo que fala com o "modelo" roda DENTRO do container, não no processo deste teste). */
const dockerLogs = apiContainerLogs;

function randomMarker(tag: string): string {
  return `T019-MARKER-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('Prompt sem cache — geração seguinte reflete a mudança, sem reiniciar o serviço (spec 029, T019) @integration', () => {
  const api = createApiClient();
  let asAdmin: StaffAuth;
  let pool: Pool;
  let jobPostingId: string;
  let originalBody: string;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('aiprompt-nocache-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });

    const seeded = await pool.query<{ body: string }>(`SELECT body FROM ai_prompts WHERE slug = $1`, [SLUG]);
    if (seeded.rows.length === 0) {
      throw new Error(`Pré-condição ausente: ai_prompts não tem linha ${SLUG} (migration 487 não aplicada?)`);
    }
    originalBody = seeded.rows[0].body;

    const jp = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status)
       VALUES ($1, 'T019 e2e — sem cache', 'AR', 'SEARCHING') RETURNING id`,
      [`T019-JP-${Date.now()}`],
    );
    jobPostingId = jp.rows[0].id;
  });

  afterAll(async () => {
    // Incondicional: roda mesmo se a asserção do `it` acima falhar (afterAll sempre executa).
    await pool.query(`UPDATE ai_prompts SET body = $1, updated_at = NOW() WHERE slug = $2`, [originalBody, SLUG]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]).catch(() => {});
    await pool.end();
  });

  it('a 2ª geração usa o conteúdo NOVO da tabela, sem reiniciar o serviço — provado por dois marcadores distintos em duas chamadas seguidas', async () => {
    const markerBefore = randomMarker('BEFORE');
    const markerAfter = randomMarker('AFTER');

    // ── alteração #1 + geração "antes" ───────────────────────────────────────────
    await pool.query(`UPDATE ai_prompts SET body = $1, updated_at = NOW() WHERE slug = $2`, [markerBefore, SLUG]);
    const logsBaseline = dockerLogs();

    const r1 = await api.post(
      `/api/admin/vacancies/${jobPostingId}/generate-talentum-description`,
      {},
      asAdmin,
    );
    expect(r1.status).toBe(200);

    const logsAfterCall1 = dockerLogs();
    const delta1 = logsAfterCall1.slice(logsBaseline.length);
    expect(delta1).toContain('[VERTEX-STUB] intercepted call');
    expect(delta1).toContain(JSON.stringify(markerBefore));

    // ── alteração #2 (SEM reiniciar o container) + geração "depois" ─────────────
    await pool.query(`UPDATE ai_prompts SET body = $1, updated_at = NOW() WHERE slug = $2`, [markerAfter, SLUG]);

    const r2 = await api.post(
      `/api/admin/vacancies/${jobPostingId}/generate-talentum-description`,
      {},
      asAdmin,
    );
    expect(r2.status).toBe(200);

    const logsAfterCall2 = dockerLogs();
    const delta2 = logsAfterCall2.slice(logsAfterCall1.length);

    // A prova central: a 2ª chamada leu o conteúdo NOVO — não o de antes, não algo em cache.
    expect(delta2).toContain('[VERTEX-STUB] intercepted call');
    expect(delta2).toContain(JSON.stringify(markerAfter));
    expect(delta2).not.toContain(JSON.stringify(markerBefore));
  });
});
