/**
 * aiPrompts.e2e.test.ts @integration — spec 029 (prompts de IA editáveis), T014.
 *
 * API real + Postgres real, sem mock. Cobre o contrato `contracts/admin-ai-prompts.md` para os
 * três manipuladores já montados nesta fase (T012/T013): `GET /ai-prompts`, `GET /ai-prompts/{slug}`
 * e `PUT /ai-prompts/{slug}`. `undo`, `restore` e `preview` são de fases posteriores e não entram
 * aqui.
 *
 * Slugs são um conjunto FECHADO (`CHECK` da migration 485 + `AI_PROMPT_SLUGS`) — não dá para criar
 * um slug "só de teste". A tabela nasce vazia (a semeadura de conteúdo real é só na Fase 3,
 * migration 487, ainda não aplicada), então este arquivo semeia e limpa suas próprias linhas para
 * `PRESCREENING_CAREGIVER` (alvo principal) e `PRESCREENING_AT` (só para o caso "listar" provar
 * mais de um registro).
 *
 * 403 (caso 6): usa `staffAuth(..., 'recruiter')` — hoje NENHUM compose do e2e liga
 * `PERMISSION_ENGINE_ENABLED` para a família `admin.integrations`, então o guard cai no caminho
 * `untilEnforced: 'admin'` (`PermissionMiddleware.passUntilEnforced`): quem não tem o papel `admin`
 * leva 403 antes mesmo de qualquer célula ABAC ser avaliada. Isto é "realmente não tem
 * `ai_prompt:read`" sem mexer em grupo nem conceder permissão nenhuma — é a ausência do papel
 * `admin` que barra, o mesmo mecanismo que barraria a célula se a família estivesse enforced.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

const SLUG = 'PRESCREENING_CAREGIVER';
const OTHER_SLUG = 'PRESCREENING_AT';
const BODY_ORIGINAL = 'Conteúdo original e2e T014 — PRESCREENING_CAREGIVER';
const BODY_ORIGINAL_OTHER = 'Conteúdo original e2e T014 — PRESCREENING_AT';

describe('Prompts de IA editáveis — API (spec 029, T014) @integration', () => {
  const api = createApiClient();
  let asAdmin: StaffAuth;
  let asRecruiter: StaffAuth;
  let pool: Pool;
  // Estado ENCONTRADO (seed da migration 491: linhas + trilha). Este teste apaga as linhas reais
  // (o CHECK da tabela fecha os slugs, não há slug próprio) — então restaura no afterAll.
  let capturedPrompts: unknown[] = [];
  let capturedAudit: unknown[] = [];

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('aiprompt-admin', 'admin');
    asRecruiter = await staffAuth('aiprompt-recruiter', 'recruiter');
    pool = new Pool({ connectionString: DATABASE_URL });

    capturedPrompts = (
      await pool.query(`SELECT to_jsonb(p) AS r FROM ai_prompts p WHERE slug IN ($1, $2)`, [SLUG, OTHER_SLUG])
    ).rows.map((x) => x.r);
    capturedAudit = (
      await pool.query(
        `SELECT to_jsonb(a) AS r FROM ai_prompt_audit_log a
          WHERE prompt_id IN (SELECT id FROM ai_prompts WHERE slug IN ($1, $2))`,
        [SLUG, OTHER_SLUG],
      )
    ).rows.map((x) => x.r);

    await pool.query(
      `DELETE FROM ai_prompt_audit_log WHERE prompt_id IN (SELECT id FROM ai_prompts WHERE slug IN ($1, $2))`,
      [SLUG, OTHER_SLUG],
    );
    await pool.query(`DELETE FROM ai_prompts WHERE slug IN ($1, $2)`, [SLUG, OTHER_SLUG]);
    await pool.query(
      `INSERT INTO ai_prompts (slug, body, version, is_active, created_by, updated_by)
       VALUES ($1, $2, 1, true, 'seed-e2e-t014', 'seed-e2e-t014')`,
      [SLUG, BODY_ORIGINAL],
    );
    await pool.query(
      `INSERT INTO ai_prompts (slug, body, version, is_active, created_by, updated_by)
       VALUES ($1, $2, 1, true, 'seed-e2e-t014', 'seed-e2e-t014')`,
      [OTHER_SLUG, BODY_ORIGINAL_OTHER],
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM ai_prompt_audit_log WHERE prompt_id IN (SELECT id FROM ai_prompts WHERE slug IN ($1, $2))`,
      [SLUG, OTHER_SLUG],
    );
    await pool.query(`DELETE FROM ai_prompts WHERE slug IN ($1, $2)`, [SLUG, OTHER_SLUG]);
    // Devolve o banco como encontrado: linhas (mesmo id) e depois a trilha que o cascade levou.
    for (const r of capturedPrompts) {
      await pool.query(`INSERT INTO ai_prompts SELECT * FROM jsonb_populate_record(NULL::ai_prompts, $1::jsonb)`, [
        JSON.stringify(r),
      ]);
    }
    for (const r of capturedAudit) {
      await pool.query(
        `INSERT INTO ai_prompt_audit_log SELECT * FROM jsonb_populate_record(NULL::ai_prompt_audit_log, $1::jsonb)`,
        [JSON.stringify(r)],
      );
    }
    await pool.end();
  });

  it('1. listar: GET /api/admin/ai-prompts devolve os prompts semeados, com conteúdo', async () => {
    const r = await api.get('/api/admin/ai-prompts', asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    const bySlug = Object.fromEntries(
      (r.data.data as Array<{ slug: string }>).map((p) => [p.slug, p]),
    );
    expect(bySlug[SLUG]).toMatchObject({ slug: SLUG, body: BODY_ORIGINAL, version: 1, isActive: true });
    expect(bySlug[OTHER_SLUG]).toMatchObject({ slug: OTHER_SLUG, body: BODY_ORIGINAL_OTHER, version: 1 });
  });

  it('2. ler um: GET /api/admin/ai-prompts/{slug} devolve o registro único', async () => {
    const r = await api.get(`/api/admin/ai-prompts/${SLUG}`, asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(r.data.data).toMatchObject({ slug: SLUG, body: BODY_ORIGINAL, version: 1 });
  });

  it('3. gravar: PUT com a version correta grava, incrementa version e registra evento UPDATED', async () => {
    const novoBody = 'Conteúdo gravado pelo T014 — versão 2';
    const r = await api.put(`/api/admin/ai-prompts/${SLUG}`, { body: novoBody, version: 1 }, asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(r.data.data).toMatchObject({ slug: SLUG, body: novoBody, version: 2 });

    const { rows } = await pool.query<{ body: string; version: number }>(
      `SELECT body, version FROM ai_prompts WHERE slug = $1`,
      [SLUG],
    );
    expect(rows[0]).toEqual({ body: novoBody, version: 2 });

    const audit = await pool.query<{ event_type: string; actor_user_id: string | null; changes: unknown }>(
      `SELECT event_type, actor_user_id, changes FROM ai_prompt_audit_log
        WHERE prompt_id = (SELECT id FROM ai_prompts WHERE slug = $1)
        ORDER BY created_at DESC LIMIT 1`,
      [SLUG],
    );
    expect(audit.rows[0].event_type).toBe('UPDATED');
    expect(audit.rows[0].actor_user_id).toBe(asAdmin.uid);
    expect(audit.rows[0].changes).toEqual({ before: BODY_ORIGINAL, after: novoBody });
  });

  it('4. conflito de versão: PUT com version desatualizada devolve 409 e NÃO grava nada', async () => {
    const antesDoConflito = await pool.query<{ body: string; version: number }>(
      `SELECT body, version FROM ai_prompts WHERE slug = $1`,
      [SLUG],
    );
    expect(antesDoConflito.rows[0].version).toBe(2); // estado deixado pelo caso 3

    const r = await api.put(
      `/api/admin/ai-prompts/${SLUG}`,
      { body: 'Tentativa com version velha — não pode gravar', version: 1 },
      asAdmin,
    );
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ success: false, error: 'version_conflict', currentVersion: 2 });

    // ⚠️ o caso que este teste existe para pegar: 409 devolvido com a gravação acontecendo mesmo
    // assim. Confere que NADA mudou no banco — nem o conteúdo, nem a versão.
    const depoisDoConflito = await pool.query<{ body: string; version: number }>(
      `SELECT body, version FROM ai_prompts WHERE slug = $1`,
      [SLUG],
    );
    expect(depoisDoConflito.rows[0]).toEqual(antesDoConflito.rows[0]);

    const auditCount = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_prompt_audit_log WHERE prompt_id = (SELECT id FROM ai_prompts WHERE slug = $1)`,
      [SLUG],
    );
    expect(auditCount.rows[0].n).toBe(1); // só o UPDATED do caso 3 — o conflito não escreveu evento novo
  });

  it('5. vazio recusado: PUT com body vazio ou só espaços devolve 400 e não grava', async () => {
    const antes = await pool.query<{ body: string; version: number }>(
      `SELECT body, version FROM ai_prompts WHERE slug = $1`,
      [SLUG],
    );

    const vazio = await api.put(
      `/api/admin/ai-prompts/${SLUG}`,
      { body: '', version: antes.rows[0].version },
      asAdmin,
    );
    expect(vazio.status).toBe(400);

    const soEspacos = await api.put(
      `/api/admin/ai-prompts/${SLUG}`,
      { body: '   ', version: antes.rows[0].version },
      asAdmin,
    );
    expect(soEspacos.status).toBe(400);

    const depois = await pool.query<{ body: string; version: number }>(
      `SELECT body, version FROM ai_prompts WHERE slug = $1`,
      [SLUG],
    );
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });

  it('6. 403 sem permissão: recruiter (sem papel admin / sem ai_prompt:read) não lista, lê nem grava', async () => {
    const list = await api.get('/api/admin/ai-prompts', asRecruiter);
    expect(list.status).toBe(403);

    const get = await api.get(`/api/admin/ai-prompts/${SLUG}`, asRecruiter);
    expect(get.status).toBe(403);

    const antes = await pool.query<{ body: string }>(`SELECT body FROM ai_prompts WHERE slug = $1`, [SLUG]);
    const put = await api.put(
      `/api/admin/ai-prompts/${SLUG}`,
      { body: 'recruiter não deveria conseguir gravar isto', version: 2 },
      asRecruiter,
    );
    expect(put.status).toBe(403);

    const depois = await pool.query<{ body: string }>(`SELECT body FROM ai_prompts WHERE slug = $1`, [SLUG]);
    expect(depois.rows[0].body).toBe(antes.rows[0].body);
  });
});
