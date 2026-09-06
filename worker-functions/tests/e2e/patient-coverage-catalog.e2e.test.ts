/**
 * patient-coverage-catalog.e2e.test.ts @integration — spec 012, US-B3 (catálogo de cobertura)
 *
 * API real + Postgres real (migrations 311-312). O que prova:
 *   1. GET /catalogs/insurance-providers devolve os 33 do contrato (staff);
 *   2. POST /catalogs/insurance-providers é admin-only (recruiter → 403), cria a opção (201), duplicado → 409,
 *      e a opção nova aparece no GET no mesmo instante (sem deploy);
 *   3. PATCH /patients/:id/coverage grava DUAS verificadas por código (source='admin_manual',
 *      provider_code = code) + cobertura informada + nº de afiliado; a ficha devolve insuranceVerifiedCodes;
 *      código fora do catálogo → 422; a trilha de affiliate_id não leva o valor (só o log — provado no unitário);
 *   4. o sync do ClickUp (repositório real) traduz o rótulo por alias e NÃO apaga o que o painel gravou.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { PatientInsuranceVerifiedRepository } from '../../src/modules/case/infrastructure/PatientInsuranceVerifiedRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

describe('Cobertura por catálogo (spec 012 US-B3) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let asRecruiter: { headers: { Authorization: string } };
  const NEW_CODE = `E2E_OS_${Date.now().toString(36).toUpperCase()}`;
  let pool: Pool;
  let patientId = '';

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('cov-admin', 'admin');
    asRecruiter = await staffAuth('cov-recruiter', 'recruiter');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'cov-e2e-%'`);
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('cov-e2e-1', 'Cobertura', 'Catalogo', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'cov-e2e-%'`);
    await pool.query(`DELETE FROM insurance_provider_aliases WHERE code = $1`, [NEW_CODE]);
    await pool.query(`DELETE FROM insurance_providers WHERE code = $1`, [NEW_CODE]);
    await pool.end();
  });

  it('1. GET /catalogs/insurance-providers: os 33 códigos do contrato, na ordem', async () => {
    const r = await api.get('/api/admin/catalogs/insurance-providers', asRecruiter);
    expect(r.status).toBe(200);
    const codes = (r.data.data.providers as Array<{ code: string }>).map((p) => p.code);
    expect(codes.length).toBeGreaterThanOrEqual(33);
    expect(codes.slice(0, 3)).toEqual(['API', 'ACCORD_SALUD', 'ASISOC']);
    expect(codes).toEqual(expect.arrayContaining(['OSDE', 'SWISS_MEDICAL', 'SANIDAD', 'PRIVATE', 'OTHER', 'IOSCOR']));
  });

  it('2. POST é admin-only; cria; duplicado → 409; aparece no GET sem deploy', async () => {
    expect((await api.post('/api/admin/catalogs/insurance-providers', { code: NEW_CODE }, asRecruiter)).status).toBe(403);
    const created = await api.post('/api/admin/catalogs/insurance-providers', { code: NEW_CODE, aliases: ['Nueva OS e2e'] }, asAdmin);
    expect(created.status).toBe(201);
    expect(created.data.data).toMatchObject({ code: NEW_CODE, active: true });
    const dup = await api.post('/api/admin/catalogs/insurance-providers', { code: NEW_CODE }, asAdmin);
    expect(dup.status).toBe(409);
    expect(dup.data.code).toBe('INSURANCE_PROVIDER_ALREADY_EXISTS');
    expect((await api.post('/api/admin/catalogs/insurance-providers', { code: 'minúsculas' }, asAdmin)).status).toBe(400);
    const list = await api.get('/api/admin/catalogs/insurance-providers', asAdmin);
    expect((list.data.data.providers as Array<{ code: string }>).map((p) => p.code)).toContain(NEW_CODE);
  });

  it('3. PATCH /coverage grava 2 verificadas por código + informada + afiliado; ficha devolve; código estranho → 422', async () => {
    const r = await api.patch(`/api/admin/patients/${patientId}/coverage`,
      { healthInsuranceName: 'OSDE 310 e2e', affiliateId: 'AF-e2e-1', insuranceVerifiedCodes: ['SWISS_MEDICAL', 'OSDE'] }, asAdmin);
    expect(r.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT ordinal, raw_label, provider_code, source FROM patient_insurance_verified WHERE patient_id = $1 ORDER BY ordinal`, [patientId]);
    expect(rows).toEqual([
      { ordinal: 1000, raw_label: 'SWISS_MEDICAL', provider_code: 'SWISS_MEDICAL', source: 'admin_manual' },
      { ordinal: 1001, raw_label: 'OSDE', provider_code: 'OSDE', source: 'admin_manual' },
    ]);
    const { rows: [p] } = await pool.query(`SELECT health_insurance_name, affiliate_id FROM patients WHERE id = $1`, [patientId]);
    expect(p).toEqual({ health_insurance_name: 'OSDE 310 e2e', affiliate_id: 'AF-e2e-1' });
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    expect(g.data.data.insuranceVerifiedCodes).toEqual(['OSDE', 'SWISS_MEDICAL']); // ordem do catálogo (15 < 28)
    expect(g.data.data.affiliateId).toBe('AF-e2e-1');
    const bad = await api.patch(`/api/admin/patients/${patientId}/coverage`, { insuranceVerifiedCodes: ['NAO_EXISTE_XYZ'] }, asAdmin);
    expect(bad.status).toBe(422);
    expect(bad.data.code).toBe('INSURANCE_PROVIDER_UNKNOWN');
    // IVA / contratación NÃO entram (lex C3.3 → bloco C)
    expect((await api.patch(`/api/admin/patients/${patientId}/coverage`, { taxCondition: 'IVA_21' }, asAdmin)).status).toBe(400);
  });

  it('4. sync do ClickUp: alias → provider_code, e as linhas do painel sobrevivem', async () => {
    const repo = new PatientInsuranceVerifiedRepository();
    const r = await repo.replaceForPatient({ patientId, read: { readable: true, labels: ['Galeno', 'Rótulo que ninguém mapeou'] } });
    expect(r.outcome).toBe('written');
    const { rows } = await pool.query(
      `SELECT ordinal, raw_label, provider_code, source FROM patient_insurance_verified WHERE patient_id = $1 ORDER BY ordinal`, [patientId]);
    expect(rows).toEqual([
      { ordinal: 1, raw_label: 'Galeno', provider_code: 'GALENO', source: 'clickup' },
      { ordinal: 2, raw_label: 'Rótulo que ninguém mapeou', provider_code: null, source: 'clickup' },
      { ordinal: 1000, raw_label: 'SWISS_MEDICAL', provider_code: 'SWISS_MEDICAL', source: 'admin_manual' },
      { ordinal: 1001, raw_label: 'OSDE', provider_code: 'OSDE', source: 'admin_manual' },
    ]);
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    expect(g.data.data.insuranceVerifiedCodes).toEqual(['GALENO', 'OSDE', 'SWISS_MEDICAL']);
  });

  it('5. GET devolve insuranceVerifiedEntries COM origem (QA 🟡3/SUP-B5) — o drawer trava o chip do ClickUp por isto', async () => {
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    expect(g.data.data.insuranceVerifiedEntries).toEqual([
      { code: 'GALENO', source: 'clickup' },
      { code: 'OSDE', source: 'admin_manual' },
      { code: 'SWISS_MEDICAL', source: 'admin_manual' },
    ]);
    // insuranceVerifiedCodes (sem origem) continua existindo, para compat.
    expect(g.data.data.insuranceVerifiedCodes).toEqual(['GALENO', 'OSDE', 'SWISS_MEDICAL']);
  });
});
