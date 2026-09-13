/**
 * patient-status-v2.e2e.test.ts @integration — spec 012, US-B7 (estado v2, motivo, Historial)
 *
 * API real (Docker, USE_MOCK_AUTH) + Postgres real com as migrations 313-315. O que prova:
 *   1. transição PERMITIDA (ACTIVE → ON_HOLD com motivo) → 200; banco com on_hold_reason/note;
 *      patient_status_history ganha a linha com change_source='admin_panel' (trigger 254 + set_config);
 *      admission_status continua DONE (trigger 313);
 *   2. transição PROIBIDA (ON_HOLD → REPLACEMENT, fora do seed da 315) → 422 com código de enum;
 *   3. ON_HOLD sem motivo → 422 ON_HOLD_REASON_REQUIRED;
 *   4. GET /status-history: quando / de→para / origem, SEM ator e SEM on_hold_note (lex C7.2/C7.3);
 *   5. sair de ON_HOLD limpa motivo e nota (nenhuma segunda cópia);
 *   6. Kanban: SOLICITANTE → ADMISSION grava e admission_status acompanha; → ACTIVE vira DONE;
 *   7. DISCHARGED/SUSPENDED não apagam linha nenhuma (lex C7.4): contagem antes/depois;
 *   8. a ficha (GET /:id) devolve admissionStatus/onHoldReason/onHoldNote; a nota nunca vai ao log
 *      do banco (patient_status_history não a tem).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const UID = 'ps-v2-admin-uid';
const NOTE = 'La obra social no autorizó — nota clínica e2e 3b7d';

describe('Estado do paciente v2 — transições, motivo, Historial (spec 012 US-B7) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let active = '';
  let lead = '';

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(UID, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'ps-v2-e2e-%'`);
    active = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('ps-v2-e2e-1', 'Estado', 'Activo', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
    lead = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('ps-v2-e2e-2', 'Estado', 'Lead', 'AR', 'SOLICITANTE') RETURNING id`,
    )).rows[0].id;

    // Decisão do Gabriel 07/09: a entrada em ACTIVE pelo `PUT /status` passou a exigir o
    // checklist bloqueante inteiro (endereço + endereço do serviço + horário do serviço) — antes
    // dela o drop no Kanban ativava sem checar nada. Esta suíte mede a FSM, o motivo e a trilha:
    // sem uma ficha completa, cada teste falharia por um motivo que não é o que ele verifica.
    // A recusa por ficha incompleta tem suíte própria (`patient-status-completeness.e2e.test.ts`).
    for (const id of [active, lead]) {
      const addr = (await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, address_formatted, display_order)
         VALUES ($1,'Calle Estado 1',1) RETURNING id`,
        [id],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO patient_contracted_services
           (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ($1,'AT',true,'AR','ps-v2-e2e','ps-v2-e2e',$2,
                 '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]'::jsonb)`,
        [id, addr],
      );
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'ps-v2-e2e-%'`);
    await pool.end();
  });

  it('1. ACTIVE → ON_HOLD com motivo e nota: 200, banco, history com origem admin_panel, admission_status DONE', async () => {
    const r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', onHoldReason: 'INSURER', onHoldNote: NOTE }, asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.data).toEqual({ id: active, status: 'ON_HOLD' });
    const { rows: [row] } = await pool.query(
      `SELECT status, admission_status, on_hold_reason, on_hold_note = $2 AS note_ok FROM patients WHERE id = $1`, [active, NOTE]);
    expect(row).toEqual({ status: 'ON_HOLD', admission_status: 'DONE', on_hold_reason: 'INSURER', note_ok: true });
    const { rows: hist } = await pool.query(
      `SELECT old_value, new_value, change_source FROM patient_status_history WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`, [active]);
    expect(hist[0]).toEqual({ old_value: 'ACTIVE', new_value: 'ON_HOLD', change_source: 'admin_panel' });
  });

  it('2. transição PROIBIDA (ON_HOLD → REPLACEMENT) → 422 PATIENT_STATUS_TRANSITION_NOT_ALLOWED, nada muda', async () => {
    const r = await api.put(`/api/admin/patients/${active}/status`, { status: 'REPLACEMENT' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ success: false, code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', details: { from: 'ON_HOLD', to: 'REPLACEMENT' } });
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [active])).rows[0].status).toBe('ON_HOLD');
  });

  it('3. ON_HOLD sem motivo → 422 ON_HOLD_REASON_REQUIRED; motivo fora do enum → 400', async () => {
    const r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('ON_HOLD_REASON_REQUIRED');
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', onHoldReason: 'BUDGET' }, asAdmin)).status).toBe(400);
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'DISCONTINUED' }, asAdmin)).status).toBe(400);
  });

  it('4. GET /status-history: quando / de→para / origem — sem ator, sem nota', async () => {
    const r = await api.get(`/api/admin/patients/${active}/status-history`, asAdmin);
    expect(r.status).toBe(200);
    const h = r.data.data.history as Array<Record<string, unknown>>;
    expect(h[0]).toMatchObject({ from: 'ACTIVE', to: 'ON_HOLD', source: 'admin_panel' });
    expect(typeof h[0].at).toBe('string');
    // a linha inicial do INSERT (trigger 255) está lá também
    expect(h[h.length - 1]).toMatchObject({ from: null, to: 'ACTIVE', source: 'insert' });
    const raw = JSON.stringify(r.data);
    expect(raw).not.toContain(NOTE);
    expect(raw).not.toMatch(/actor|uid/i);
  });

  it('5. ON_HOLD → ACTIVE limpa motivo e nota; ficha devolve os campos v2', async () => {
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'ACTIVE' }, asAdmin)).status).toBe(200);
    const { rows: [row] } = await pool.query(`SELECT status, on_hold_reason, on_hold_note FROM patients WHERE id = $1`, [active]);
    expect(row).toEqual({ status: 'ACTIVE', on_hold_reason: null, on_hold_note: null });
    const g = await api.get(`/api/admin/patients/${active}`, asAdmin);
    expect(g.status).toBe(200);
    expect(g.data.data).toMatchObject({ status: 'ACTIVE', admissionStatus: 'DONE', onHoldReason: null, onHoldNote: null, serviceStartDate: null });
  });

  it('6. Kanban: SOLICITANTE → ADMISSION (livre) e ADMISSION → ACTIVE (seed 315) — admission_status acompanha', async () => {
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'ADMISSION', changeSource: 'kanban' }, asAdmin)).status).toBe(200);
    let row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'ADMISSION', admission_status: 'ADMISSION' });
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE', changeSource: 'kanban' }, asAdmin)).status).toBe(200);
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'ACTIVE', admission_status: 'DONE' });
    const hist = (await api.get(`/api/admin/patients/${lead}/status-history`, asAdmin)).data.data.history as Array<Record<string, unknown>>;
    expect(hist[0]).toMatchObject({ from: 'ADMISSION', to: 'ACTIVE', source: 'kanban' });
  });

  it('7. DISCHARGED e SUSPENDED não apagam linha nenhuma (lex C7.4)', async () => {
    const count = async () => Number((await pool.query(`SELECT count(*) AS n FROM patients WHERE clickup_task_id LIKE 'ps-v2-e2e-%'`)).rows[0].n);
    const before = await count();
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'SUSPENDED' }, asAdmin)).status).toBe(200);
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'DISCHARGED' }, asAdmin)).status).toBe(200);
    expect(await count()).toBe(before);
    expect((await pool.query(`SELECT deleted_at FROM patients WHERE id = $1`, [lead])).rows[0].deleted_at).toBeNull();
    // resgate (#REGRA-07): DISCHARGED → ACTIVE está no seed
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE' }, asAdmin)).status).toBe(200);
  });

  it('8. listagem devolve admissionStatus (o que o Kanban lê)', async () => {
    const r = await api.get(`/api/admin/patients?search=Estado&limit=50`, asAdmin);
    expect(r.status).toBe(200);
    const mine = (r.data.data as Array<{ id: string; admissionStatus: string }>).filter((p) => p.id === active || p.id === lead);
    expect(mine.map((p) => p.admissionStatus)).toEqual(['DONE', 'DONE']);
  });
});
