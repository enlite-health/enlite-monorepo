/**
 * country-scope-pacientes.e2e.test.ts — hotfix 18/11/2026: "Informacoes do Brasil so podem ser vistas por GRUPOS
 * SETADOS COM BRASIL". Com `COUNTRY_RLS_ENABLED=false` o banco nao recorta, entao o recorte e da aplicacao
 * (`resolveCountryScope` + `patientCountryScopeGuard`). API e Postgres REAIS, sem mock de repositorio.
 *
 * Cenario: 1 paciente AR + 1 BR (cada um com 1 servico contratado e 1 endereco).
 *   - ator so-AR (grupo com escopo AR):  lista sem BR; ficha BR 404; filha BR (enderecos) 404; kanban sem BR.
 *   - ator AR+BR:                        ve os dois.
 *   - ator sem pais em nenhum grupo:     403 COUNTRY_SCOPE_REQUIRED na lista (nada de "todos").
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const RUN = Date.now();
const UID_AR = `csp-ar-${RUN}`;
const UID_ARBR = `csp-arbr-${RUN}`;
const UID_NONE = `csp-none-${RUN}`;
const G_AR = randomUUID();
const G_ARBR = randomUUID();

describe('Escopo por pais — pacientes (lista, ficha, filhas, kanban) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let tAR: string;
  let tARBR: string;
  let tNone: string;
  let patAR: string;
  let patBR: string;
  const authz = (t: string) => ({ headers: { Authorization: `Bearer ${t}` }, validateStatus: () => true });

  async function seedPatient(country: 'AR' | 'BR', tag: string): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, $2, $3, 'CountryScope', $4)`, [
      id, `csp-${RUN}-${tag}`, `Csp${tag}`, country,
    ]);
    await pool.query(
      `INSERT INTO patient_contracted_services (patient_id, service_code, country, created_by, updated_by, active) VALUES ($1, 'AT', $2, 'csp-e2e', 'csp-e2e', true)`,
      [id, country],
    );
    return id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    tAR = await getMockToken(api, { uid: UID_AR, email: `${UID_AR}@e2e.local`, role: 'admin' });
    tARBR = await getMockToken(api, { uid: UID_ARBR, email: `${UID_ARBR}@e2e.local`, role: 'admin' });
    tNone = await getMockToken(api, { uid: UID_NONE, email: `${UID_NONE}@e2e.local`, role: 'admin' });
    for (const uid of [UID_AR, UID_ARBR, UID_NONE]) {
      await pool.query(
        `INSERT INTO users (firebase_uid, email, role, is_active, tenant_id) VALUES ($1, $2, 'admin', true, $3) ON CONFLICT (firebase_uid) DO NOTHING`,
        [uid, `${uid}@e2e.local`, TENANT_ID],
      );
    }
    await pool.query(`INSERT INTO permission_groups (id, tenant_id, name) VALUES ($1, $3, 'csp so AR'), ($2, $3, 'csp AR+BR')`, [G_AR, G_ARBR, TENANT_ID]);
    await pool.query(`INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES ($1, $3, $5), ($2, $4, $5)`, [UID_AR, UID_ARBR, G_AR, G_ARBR, TENANT_ID]);
    await pool.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES
         ($1, $3, 'AR', 'csp-e2e', 'teste'), ($2, $4, 'AR', 'csp-e2e', 'teste'), ($5, $4, 'BR', 'csp-e2e', 'teste')`,
      [randomUUID(), randomUUID(), G_AR, G_ARBR, randomUUID()],
    );
    patAR = await seedPatient('AR', 'ar');
    patBR = await seedPatient('BR', 'br');
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patient_contracted_services WHERE created_by = 'csp-e2e'`);
    await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [[patAR, patBR]]);
    await pool.query(`DELETE FROM group_country_scopes WHERE group_id = ANY($1::uuid[])`, [[G_AR, G_ARBR]]);
    await pool.query(`DELETE FROM user_groups WHERE group_id = ANY($1::uuid[])`, [[G_AR, G_ARBR]]);
    await pool.query(`DELETE FROM permission_groups WHERE id = ANY($1::uuid[])`, [[G_AR, G_ARBR]]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1::text[])`, [[UID_AR, UID_ARBR, UID_NONE]]);
    await pool.end();
  });

  it('(a) so-AR: GET /patients sem ?country -> nenhuma linha BR, a AR presente', async () => {
    const res = await api.get('/api/admin/patients?limit=200', authz(tAR));
    expect(res.status).toBe(200);
    const ids: string[] = res.data.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(patAR);
    expect(ids).not.toContain(patBR);
  });

  it('(a2) so-AR: ?country=BR -> 403 COUNTRY_SCOPE_REQUIRED (nunca os dados BR)', async () => {
    const res = await api.get('/api/admin/patients?country=BR', authz(tAR));
    expect(res.status).toBe(403);
    expect(res.data.error).toBe('COUNTRY_SCOPE_REQUIRED');
  });

  it('(b) so-AR: GET /patients/<idBR> -> 404; o AR -> 200', async () => {
    expect((await api.get(`/api/admin/patients/${patBR}`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/patients/${patAR}`, authz(tAR))).status).toBe(200);
  });

  it('(c) so-AR: rotas filhas do BR -> 404 (leitura e escrita); as do AR passam do guard', async () => {
    expect((await api.get(`/api/admin/patients/${patBR}/addresses`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/patients/${patBR}/contracted-services`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/patients/${patBR}/status-history`, authz(tAR))).status).toBe(404);
    expect((await api.put(`/api/admin/patients/${patBR}/status`, { status: 'ACTIVE' }, authz(tAR))).status).toBe(404);
    // Filhas montadas em OUTROS routers (conversa, equipe do servico, projeto terapeutico): o guard e global, nao por router.
    expect((await api.get(`/api/admin/patients/${patBR}/conversation`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/patients/${patBR}/therapeutic-projects`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/patients/${patBR}/contracted-services/${randomUUID()}/team`, authz(tAR))).status).toBe(404);
    expect((await api.get(`/api/admin/patients/${patAR}/addresses`, authz(tAR))).status).toBe(200);
  });

  it('(d) AR+BR: ve os dois na lista e abre a ficha BR', async () => {
    const res = await api.get('/api/admin/patients?limit=200', authz(tARBR));
    expect(res.status).toBe(200);
    const ids: string[] = res.data.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining([patAR, patBR]));
    expect((await api.get(`/api/admin/patients/${patBR}`, authz(tARBR))).status).toBe(200);
  });

  it('(e) kanban/services: so-AR sem BR; AR+BR com os dois', async () => {
    const ar = await api.get('/api/admin/patients/kanban/services', authz(tAR));
    expect(ar.status).toBe(200);
    const arIds: string[] = ar.data.data.patients.map((p: { patientId: string }) => p.patientId);
    expect(arIds).toContain(patAR);
    expect(arIds).not.toContain(patBR);
    const both = await api.get('/api/admin/patients/kanban/services', authz(tARBR));
    const bothIds: string[] = both.data.data.patients.map((p: { patientId: string }) => p.patientId);
    expect(bothIds).toEqual(expect.arrayContaining([patAR, patBR]));
  });

  it('(f) sem pais em nenhum grupo: lista, ficha e kanban -> 403 COUNTRY_SCOPE_REQUIRED (nunca "todos")', async () => {
    for (const path of ['/api/admin/patients', `/api/admin/patients/${patAR}`, '/api/admin/patients/kanban/services']) {
      const res = await api.get(path, authz(tNone));
      expect(res.status).toBe(403);
      expect(res.data.error).toBe('COUNTRY_SCOPE_REQUIRED');
    }
  });
});
