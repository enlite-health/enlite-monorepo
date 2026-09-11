/**
 * patient-address-logistics.e2e.test.ts @integration — spec 012, US-B2 / B4 / B9 (lex C2.*)
 *
 * API real + Postgres real (migrations 307-310, 316, 317). O que prova:
 *   1. POST /patients/:id/addresses com zona + corredor + acesso: 201; `country` = do paciente
 *      (NOT NULL sem default, trigger/explícito); `access_notes` NUNCA na resposta de erro;
 *      teto 2000 → 400 (lex C2.6);
 *   2. PATCH /patients/:id/addresses/:addressId edita os 3 campos; endereço de outro paciente → 404;
 *   3. a ficha devolve neighborhood/logisticsCorridor/accessNotes/country por endereço;
 *   4. POST /activate sem sair da ficha: vaga borrador por endereço, ACTIVE, admission_status DONE,
 *      e `service_start_date` NÃO muda ao abrir vaga (US-B9);
 *   5. drawer clínico: deviceTypes HOME+SCHOOL → patient_device_types + escalar derivado pela 310;
 *      re-salvar o MESMO conjunto não altera linhas (created_at igual); código estranho → 422;
 *      `deviceType` (texto livre) → 400 — era 23503 (LISTA B0 #1);
 *   6. PATCH /general com serviceStartDate grava; drawer familiares com relationship fora do enum → 400.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ACCESS = 'Timbre 3B, portero de 8 a 12 — nota e2e 5d1e';

describe('Domicílio na ficha, dispositivo por catálogo, início do serviço (spec 012) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let patientId = '';
  let otherId = '';
  let addressId = '';

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('addr-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'addr-e2e-%'`);
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number, service_start_date)
       VALUES ('addr-e2e-1', 'Domicilio', 'Ficha', 'BR', 'PENDING_ADMISSION', 990001, '2026-08-15') RETURNING id`,
    )).rows[0].id;
    otherId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('addr-e2e-2', 'Otro', 'Paciente', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN ($1, $2)`, [patientId, otherId]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'addr-e2e-%'`);
    await pool.end();
  });

  it('1. cria endereço com logística; country vem do paciente; teto 2000 → 400 sem ecoar o valor', async () => {
    const r = await api.post(`/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Rua Augusta 975, São Paulo', address_type: 'primary', neighborhood: 'Consolação', logistics_corridor: 'Centro', access_notes: ACCESS }, asAdmin);
    expect(r.status).toBe(201);
    addressId = r.data.data.id;
    const { rows: [row] } = await pool.query(
      `SELECT country, neighborhood, logistics_corridor, access_notes = $2 AS notes_ok FROM patient_addresses WHERE id = $1`, [addressId, ACCESS]);
    expect(row).toEqual({ country: 'BR', neighborhood: 'Consolação', logistics_corridor: 'Centro', notes_ok: true });

    const tooLong = await api.post(`/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'X 1', access_notes: 'n'.repeat(2001) }, asAdmin);
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.data)).not.toContain('nnnnnnnnnn');
  });

  it('2. PATCH edita os 3 campos; endereço de OUTRO paciente → 404; chave estranha → 400', async () => {
    const r = await api.patch(`/api/admin/patients/${patientId}/addresses/${addressId}`,
      { neighborhood: 'Bela Vista', logistics_corridor: 'Sul', access_notes: null }, asAdmin);
    expect(r.status).toBe(200);
    const { rows: [row] } = await pool.query(`SELECT neighborhood, logistics_corridor, access_notes FROM patient_addresses WHERE id = $1`, [addressId]);
    expect(row).toEqual({ neighborhood: 'Bela Vista', logistics_corridor: 'Sul', access_notes: null });
    expect((await api.patch(`/api/admin/patients/${otherId}/addresses/${addressId}`, { neighborhood: 'x' }, asAdmin)).status).toBe(404);
    expect((await api.patch(`/api/admin/patients/${patientId}/addresses/${addressId}`, { address_formatted: 'hack' }, asAdmin)).status).toBe(400);
    expect((await api.patch(`/api/admin/patients/${patientId}/addresses/${addressId}`, { access_notes: ACCESS }, asAdmin)).status).toBe(200);
  });

  it('3. a ficha devolve a logística por endereço', async () => {
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    expect(g.status).toBe(200);
    expect(g.data.data.addresses[0]).toMatchObject({ id: addressId, neighborhood: 'Bela Vista', logisticsCorridor: 'Sul', accessNotes: ACCESS, country: 'BR' });
    expect(g.data.data.serviceStartDate).toMatch(/^2026-08-15/);
  });

  it('4. ativar sem sair da ficha: vaga borrador por endereço, ACTIVE/DONE, service_start_date intacta (US-B9)', async () => {
    const before = (await pool.query(`SELECT service_start_date::text AS d FROM patients WHERE id = $1`, [patientId])).rows[0].d;
    const r = await api.post(`/api/admin/patients/${patientId}/activate`, {}, asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.data.createdVacancyIds).toHaveLength(1);
    const { rows: [row] } = await pool.query(`SELECT status, admission_status, service_start_date::text AS d FROM patients WHERE id = $1`, [patientId]);
    expect(row).toEqual({ status: 'ACTIVE', admission_status: 'DONE', d: before });
    expect(before).toBe('2026-08-15');
  });

  it('5. dispositivo por catálogo: HOME+SCHOOL, escalar derivado, re-salvar não altera, código estranho 422, texto livre 400', async () => {
    const r = await api.patch(`/api/admin/patients/${patientId}/clinical`, { deviceTypes: ['SCHOOL', 'HOME'] }, asAdmin);
    expect(r.status).toBe(200);
    const read = async () => (await pool.query(
      `SELECT pdt.device_type, pdt.source, pdt.created_at::text AS at FROM patient_device_types pdt JOIN device_types d ON d.code = pdt.device_type WHERE patient_id = $1 ORDER BY d.sort_order`, [patientId])).rows;
    const first = await read();
    expect(first.map((x) => [x.device_type, x.source])).toEqual([['HOME', 'admin_manual'], ['SCHOOL', 'admin_manual']]);
    expect((await pool.query(`SELECT device_type FROM patients WHERE id = $1`, [patientId])).rows[0].device_type).toBe('HOME'); // trigger 310
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    expect(g.data.data.deviceTypes).toEqual(['HOME', 'SCHOOL']);

    // re-salvar o MESMO conjunto (outra ordem) → nenhuma linha nova (created_at igual)
    expect((await api.patch(`/api/admin/patients/${patientId}/clinical`, { deviceTypes: ['HOME', 'SCHOOL'] }, asAdmin)).status).toBe(200);
    expect(await read()).toEqual(first);

    const bad = await api.patch(`/api/admin/patients/${patientId}/clinical`, { deviceTypes: ['CASA'] }, asAdmin);
    expect(bad.status).toBe(422);
    expect(bad.data.code).toBe('DEVICE_TYPE_UNKNOWN');
    expect((await api.patch(`/api/admin/patients/${patientId}/clinical`, { deviceType: 'Silla de ruedas' }, asAdmin)).status).toBe(400);
  });

  it('6. serviceStartDate no drawer geral grava; relationship fora do enum → 400 (US-B5/B9)', async () => {
    expect((await api.patch(`/api/admin/patients/${patientId}/general`, { serviceStartDate: '2026-09-10' }, asAdmin)).status).toBe(200);
    expect((await pool.query(`SELECT service_start_date::text AS d FROM patients WHERE id = $1`, [patientId])).rows[0].d).toBe('2026-09-10');
    // `PATCH /support-network` saiu (spec 018, PR-1, ADR-1, SUP-37) — a escrita de responsáveis
    // agora é por LINHA (`POST/PATCH .../responsibles`); a rota antiga fica 410 incondicional.
    const gone = await api.patch(`/api/admin/patients/${patientId}/support-network`, {}, asAdmin);
    expect(gone.status).toBe(410);
    const bad = await api.post(`/api/admin/patients/${patientId}/responsibles`,
      { firstName: 'Ana', lastName: 'Diaz', relationship: 'Madre', isPrimary: true, phone: '+5491100000001' }, asAdmin);
    expect(bad.status).toBe(400);
    const ok = await api.post(`/api/admin/patients/${patientId}/responsibles`,
      { firstName: 'Ana', lastName: 'Diaz', relationship: 'PARENT', isPrimary: true, phone: '+5491100000001' }, asAdmin);
    expect(ok.status).toBe(201);
    expect((await pool.query(`SELECT relationship FROM patient_responsibles WHERE patient_id = $1`, [patientId])).rows[0].relationship).toBe('PARENT');
  });
});
