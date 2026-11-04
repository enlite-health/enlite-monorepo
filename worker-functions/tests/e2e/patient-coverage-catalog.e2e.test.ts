/**
 * patient-coverage-catalog.e2e.test.ts @integration — spec 012, US-B3 (catálogo de cobertura)
 *
 * API real + Postgres real (migrations 311-312). O que prova:
 *   1. GET /catalogs/insurance-providers devolve os 33 do contrato (staff);
 *   2. POST /catalogs/insurance-providers é admin-only (recruiter → 403), cria a opção (201), duplicado → 409,
 *      e a opção nova aparece no GET no mesmo instante (sem deploy);
 *   3. PATCH /patients/:id/coverage grava a cobertura informada + o nº de afiliado; `insuranceVerifiedCodes` SAIU do PATCH (spec 087):
 *      400 pelo `.strict()` e nada é gravado em patient_insurance_verified; a trilha de affiliate_id não leva o valor (só o log —
 *      provado no unitário). As linhas `admin_manual` legadas (gravadas antes da 087) seguem legíveis na ficha;
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
    // Spec 058: o POST pede `name` (o código é derivado se faltar) e o duplicado vem por NOME de constraint.
    expect((await api.post('/api/admin/catalogs/insurance-providers', { name: 'Nueva OS e2e', code: NEW_CODE }, asRecruiter)).status).toBe(403);
    const created = await api.post('/api/admin/catalogs/insurance-providers', { name: 'Nueva OS e2e', code: NEW_CODE, aliases: ['Nueva OS e2e'] }, asAdmin);
    expect(created.status).toBe(201);
    expect(created.data.data).toMatchObject({ code: NEW_CODE, name: 'Nueva OS e2e', active: true });
    const dup = await api.post('/api/admin/catalogs/insurance-providers', { name: 'Otro nombre e2e', code: NEW_CODE }, asAdmin);
    expect(dup.status).toBe(409);
    expect(dup.data.code).toBe('INSURANCE_PROVIDER_CODE_EXISTS');
    const dupName = await api.post('/api/admin/catalogs/insurance-providers', { name: ' nueva os E2E ', code: `${NEW_CODE}_2` }, asAdmin);
    expect(dupName.status).toBe(409);
    expect(dupName.data.code).toBe('INSURANCE_PROVIDER_NAME_EXISTS');
    expect((await api.post('/api/admin/catalogs/insurance-providers', { name: 'Minúsculas', code: 'minúsculas' }, asAdmin)).status).toBe(400);
    const list = await api.get('/api/admin/catalogs/insurance-providers', asAdmin);
    expect((list.data.data.providers as Array<{ code: string }>).map((p) => p.code)).toContain(NEW_CODE);
  });

  it('3. PATCH /coverage grava informada + afiliado; insuranceVerifiedCodes → 400 e nada gravado (spec 087); linhas legadas seguem legíveis', async () => {
    const r = await api.patch(`/api/admin/patients/${patientId}/coverage`,
      { healthInsuranceName: 'OSDE 310 e2e', affiliateId: 'AF-e2e-1' }, asAdmin);
    expect(r.status).toBe(200);
    const { rows: [p] } = await pool.query(`SELECT insurance_informed, affiliate_id FROM patients WHERE id = $1`, [patientId]);
    expect(p).toEqual({ insurance_informed: 'OSDE 310 e2e', affiliate_id: 'AF-e2e-1' });
    // Spec 087 (decisão 5): a escrita das verificadas saiu do PATCH — o `.strict()` recusa a chave, bem formada ou não, e NADA é gravado.
    for (const body of [{ insuranceVerifiedCodes: ['SWISS_MEDICAL', 'OSDE'] }, { insuranceVerifiedCodes: ['NAO_EXISTE_XYZ'] }, { insuranceVerifiedCodes: [] }, { affiliateId: 'AF-e2e-2', insuranceVerifiedCodes: ['OSDE'] }]) {
      const bad = await api.patch(`/api/admin/patients/${patientId}/coverage`, body, asAdmin);
      expect(bad.status).toBe(400);
    }
    const { rows: gravadas } = await pool.query(`SELECT 1 FROM patient_insurance_verified WHERE patient_id = $1`, [patientId]);
    expect(gravadas).toHaveLength(0);
    const { rows: [afiliado] } = await pool.query(`SELECT affiliate_id FROM patients WHERE id = $1`, [patientId]);
    expect(afiliado).toEqual({ affiliate_id: 'AF-e2e-1' }); // o PATCH recusado inteiro não aplicou o afiliado novo
    // Linhas `admin_manual` legadas (gravadas antes da 087) seguem na ficha: semeadas pelo repositório, que continua existindo.
    await new PatientInsuranceVerifiedRepository().replaceCodesForPatient(patientId, ['SWISS_MEDICAL', 'OSDE']);
    const { rows } = await pool.query(
      `SELECT ordinal, raw_label, provider_code, source FROM patient_insurance_verified WHERE patient_id = $1 ORDER BY ordinal`, [patientId]);
    expect(rows).toEqual([
      { ordinal: 1000, raw_label: 'SWISS_MEDICAL', provider_code: 'SWISS_MEDICAL', source: 'admin_manual' },
      { ordinal: 1001, raw_label: 'OSDE', provider_code: 'OSDE', source: 'admin_manual' },
    ]);
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    expect(g.data.data.insuranceVerifiedCodes).toEqual(['OSDE', 'SWISS_MEDICAL']); // ordem do catálogo (15 < 28)
    expect(g.data.data.affiliateId).toBe('AF-e2e-1');
    // IVA / contratación NÃO entram (lex C3.3 → bloco C)
    expect((await api.patch(`/api/admin/patients/${patientId}/coverage`, { taxCondition: 'IVA_21' }, asAdmin)).status).toBe(400);
    // Spec 058: o nº de afiliado legado saiu do fio — 422 com o motivo (o dono é `affiliateId`), em qualquer seção.
    for (const secao of ['coverage', 'general']) {
      const legado = await api.patch(`/api/admin/patients/${patientId}/${secao}`, { healthInsuranceMemberId: 'X-1' }, asAdmin);
      expect(legado.status).toBe(422);
      expect(legado.data).toMatchObject({ code: 'LEGACY_FIELD_REMOVED', details: { fields: ['healthInsuranceMemberId'] } });
    }
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

  it('5. GET devolve coverage.entries COM origem (QA 🟡3/SUP-B5, spec 058) — o drawer trava o chip do ClickUp por isto; o rótulo sem mapeamento sai sem o texto cru', async () => {
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const { coverage } = g.data.data;
    // A informada (teste 3) vence o display; as entradas verificadas seguem inteiras, com a origem.
    expect(coverage).toMatchObject({ display: 'OSDE 310 e2e', displaySource: 'INFORMED' });
    expect(coverage.entries.map((e: { code: string | null; mapped: boolean; source: string }) => ({ code: e.code, mapped: e.mapped, source: e.source }))).toEqual([
      { code: 'GALENO', mapped: true, source: 'clickup' },
      { code: 'OSDE', mapped: true, source: 'admin_manual' },
      { code: 'SWISS_MEDICAL', mapped: true, source: 'admin_manual' },
      { code: null, mapped: false, source: 'clickup' },
    ]);
    expect(JSON.stringify(coverage)).not.toContain('Rótulo que ninguém mapeou');
    // insuranceVerifiedCodes (sem origem) continua existindo, para compat; o campo antigo saiu do fio.
    expect(g.data.data.insuranceVerifiedCodes).toEqual(['GALENO', 'OSDE', 'SWISS_MEDICAL']);
    expect(g.data.data).not.toHaveProperty('insuranceVerifiedEntries');
    expect(g.data.data).not.toHaveProperty('insuranceVerified');
  });
});
