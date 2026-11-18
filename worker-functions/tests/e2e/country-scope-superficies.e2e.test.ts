/**
 * country-scope-superficies.e2e.test.ts — hotfix 18/11/2026 (continuacao de country-scope-pacientes): "NENHUMA
 * informacao do Brasil pode ser mostrada se o usuario NAO TEM permissao Brasil". API e Postgres REAIS.
 *
 * Familias cobertas aqui: WORKERS (lista, ficha, filha, stats, export), VAGAS (lista, ficha, filha, stats) e
 * AGREGADOS de dashboard (alertas de vagas, contador de vagas). Ator so-AR nunca recebe BR; ator AR+BR recebe os dois;
 * agregado: a contagem do so-AR NAO inclui o BR (diferenca >= 1 contra o AR+BR).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const RUN = Date.now();
const UID_AR = `css-ar-${RUN}`;
const UID_ARBR = `css-arbr-${RUN}`;
const G_AR = randomUUID();
const G_ARBR = randomUUID();

describe('Escopo por pais — workers, vagas e agregados @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let tAR: string;
  let tARBR: string;
  let wAR: string;
  let wBR: string;
  let vAR: string;
  let vBR: string;
  const authz = (t: string) => ({ headers: { Authorization: `Bearer ${t}` }, validateStatus: () => true });

  async function seedWorker(country: 'AR' | 'BR'): Promise<string> {
    const r = await pool.query(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, $3) RETURNING id`, [
      `css-${RUN}-w-${country}`, `css-${RUN}-w-${country}@e2e.local`, country,
    ]);
    return r.rows[0].id as string;
  }

  async function seedVacancy(country: 'AR' | 'BR'): Promise<string> {
    const r = await pool.query(
      `INSERT INTO job_postings (title, description, country, status, is_draft, case_number, case_ordinal, search_start_date)
       VALUES ($1, 'desc', $2, 'SEARCHING', false, $3, 1, NOW() - interval '10 days') RETURNING id`,
      [`css-${RUN}-v-${country}`, country, country === 'AR' ? 910001 : 910002],
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    tAR = await getMockToken(api, { uid: UID_AR, email: `${UID_AR}@e2e.local`, role: 'admin', countryGrant: false });
    tARBR = await getMockToken(api, { uid: UID_ARBR, email: `${UID_ARBR}@e2e.local`, role: 'admin', countryGrant: false });
    for (const uid of [UID_AR, UID_ARBR]) {
      await pool.query(
        `INSERT INTO users (firebase_uid, email, role, is_active, tenant_id) VALUES ($1, $2, 'admin', true, $3) ON CONFLICT (firebase_uid) DO NOTHING`,
        [uid, `${uid}@e2e.local`, TENANT_ID],
      );
    }
    await pool.query(`INSERT INTO permission_groups (id, tenant_id, name) VALUES ($1, $3, 'css so AR'), ($2, $3, 'css AR+BR')`, [G_AR, G_ARBR, TENANT_ID]);
    await pool.query(`INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES ($1, $3, $5), ($2, $4, $5)`, [UID_AR, UID_ARBR, G_AR, G_ARBR, TENANT_ID]);
    await pool.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES
         ($1, $3, 'AR', 'css-e2e', 'teste'), ($2, $4, 'AR', 'css-e2e', 'teste'), ($5, $4, 'BR', 'css-e2e', 'teste')`,
      [randomUUID(), randomUUID(), G_AR, G_ARBR, randomUUID()],
    );
    wAR = await seedWorker('AR');
    wBR = await seedWorker('BR');
    vAR = await seedVacancy('AR');
    vBR = await seedVacancy('BR');
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [[vAR, vBR]]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [[wAR, wBR]]);
    await pool.query(`DELETE FROM group_country_scopes WHERE group_id = ANY($1::uuid[])`, [[G_AR, G_ARBR]]);
    await pool.query(`DELETE FROM user_groups WHERE group_id = ANY($1::uuid[])`, [[G_AR, G_ARBR]]);
    await pool.query(`DELETE FROM permission_groups WHERE id = ANY($1::uuid[])`, [[G_AR, G_ARBR]]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1::text[])`, [[UID_AR, UID_ARBR]]);
    await pool.end();
  });

  // ── WORKERS ────────────────────────────────────────────────────────────────
  it('workers: so-AR -> lista sem BR; ficha BR 404; filha BR (timeline) 404; AR+BR ve os dois', async () => {
    const ar = await api.get('/api/admin/workers?limit=200', authz(tAR));
    expect(ar.status).toBe(200);
    const arIds: string[] = ar.data.data.map((w: { worker: { id: string } } | { id: string }) => ('worker' in w ? w.worker.id : w.id));
    expect(arIds).toContain(wAR);
    expect(arIds).not.toContain(wBR);

    expect((await api.get(`/api/admin/workers/${wBR}`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/workers/${wBR}/timeline`, authz(tAR))).status).toBe(404);
    expect((await api.post(`/api/admin/workers/${wBR}/documents/view-url`, {}, authz(tAR))).status).toBe(404); // router de documentos
    expect((await api.get(`/api/admin/workers/${wAR}`, authz(tAR))).status).toBe(200);

    const both = await api.get('/api/admin/workers?limit=200', authz(tARBR));
    const bothIds: string[] = both.data.data.map((w: { worker: { id: string } } | { id: string }) => ('worker' in w ? w.worker.id : w.id));
    expect(bothIds).toEqual(expect.arrayContaining([wAR, wBR]));
    expect((await api.get(`/api/admin/workers/${wBR}`, authz(tARBR))).status).not.toBe(404);
  });

  it('workers: agregado /workers/stats do so-AR NAO inclui o BR (o AR+BR conta >= 1 a mais hoje)', async () => {
    const ar = await api.get('/api/admin/workers/stats', authz(tAR));
    const both = await api.get('/api/admin/workers/stats', authz(tARBR));
    expect(ar.status).toBe(200);
    expect(both.data.data.sevenDaysAgo - ar.data.data.sevenDaysAgo).toBeGreaterThanOrEqual(1);
  });

  // ── VAGAS ──────────────────────────────────────────────────────────────────
  it('vagas: so-AR -> lista sem BR; ficha BR 404; filha BR (funnel) 404; AR+BR ve as duas', async () => {
    const ar = await api.get('/api/admin/vacancies?limit=200', authz(tAR));
    expect(ar.status).toBe(200);
    const arIds: string[] = ar.data.data.map((v: { id: string }) => v.id);
    expect(arIds).toContain(vAR);
    expect(arIds).not.toContain(vBR);

    expect((await api.get(`/api/admin/vacancies/${vBR}`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/vacancies/${vBR}/funnel`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/vacancies/${vBR}/enquadre-events`, authz(tAR))).status).toBe(404); // router de encuadres (param :vacancyId)
    expect((await api.get(`/api/admin/vacancies/${vAR}`, authz(tAR))).status).toBe(200);

    const both = await api.get('/api/admin/vacancies?limit=200', authz(tARBR));
    const bothIds: string[] = both.data.data.map((v: { id: string }) => v.id);
    expect(bothIds).toEqual(expect.arrayContaining([vAR, vBR]));
    expect((await api.get(`/api/admin/vacancies/${vBR}`, authz(tARBR))).status).toBe(200);
  });

  // ── AGREGADOS ──────────────────────────────────────────────────────────────
  it('agregado: /vacancies/stats (+7 dias) do so-AR NAO inclui a vaga BR', async () => {
    const ar = await api.get('/api/admin/vacancies/stats', authz(tAR));
    const both = await api.get('/api/admin/vacancies/stats', authz(tARBR));
    expect(ar.status).toBe(200);
    const mais7 = (r: { data: { data: Array<{ label: string; value: string }> } }) => Number(r.data.data.find((s) => s.label === '+7 dias')!.value);
    expect(mais7(both) - mais7(ar)).toBeGreaterThanOrEqual(1);
  });

  it('agregado: /dashboard/alerts do so-AR nao lista a vaga BR; o AR+BR lista', async () => {
    const ar = await api.get('/api/admin/dashboard/alerts', authz(tAR));
    const both = await api.get('/api/admin/dashboard/alerts', authz(tARBR));
    expect(ar.status).toBe(200);
    expect(ar.data.data.map((a: { jobPostingId: string }) => a.jobPostingId)).not.toContain(vBR);
    expect(both.data.data.map((a: { jobPostingId: string }) => a.jobPostingId)).toContain(vBR);
  });

  it('sem pais: ficha de worker/vaga de usuario sem grupo => 403 COUNTRY_SCOPE_REQUIRED (nunca dado)', async () => {
    const tNone = await getMockToken(api, { uid: `css-none-${RUN}`, email: `css-none-${RUN}@e2e.local`, role: 'admin', countryGrant: false });
    for (const p of [`/api/admin/workers/${wAR}`, `/api/admin/vacancies/${vAR}`, '/api/admin/workers', '/api/admin/vacancies']) {
      const res = await api.get(p, authz(tNone));
      expect(res.status).toBe(403);
      expect(res.data.error).toBe('COUNTRY_SCOPE_REQUIRED');
    }
  });
});
