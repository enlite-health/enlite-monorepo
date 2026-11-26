/**
 * patient-status-v2.e2e.test.ts @integration — spec 012, US-B7 (estado v2, motivo, Historial)
 *
 * API real (Docker, USE_MOCK_AUTH) + Postgres real com as migrations 313-315. O que prova:
 *   1. transição PERMITIDA (ACTIVE → ON_HOLD com motivo) → 200; banco com on_hold_reason/note;
 *      patient_status_history ganha a linha com change_source='admin_panel' (trigger 254 + set_config);
 *      admission_status continua DONE (trigger 313);
 *   2. F5 (estado-automatico-do-paciente): destino DERIVADO (ON_HOLD → REPLACEMENT) pelo PUT → 422 PATIENT_STATUS_NOT_MANUAL;
 *   3. ON_HOLD sem motivo → 422 ON_HOLD_REASON_REQUIRED;
 *   4. GET /status-history: quando / de→para / origem / motivo / autor (migration 486, decisão do
 *      Gabriel 29/09/2026), SEM on_hold_note (C7.3);
 *   5. sair de ON_HOLD limpa motivo e nota (nenhuma segunda cópia);
 *   6. Migration 428 (spec 018 PR-6, ADR-5): funil→ACTIVE direto (SOLICITANTE, ADMISSION,
 *      PENDING_ADMISSION) passa a ser 422 PATIENT_STATUS_TRANSITION_NOT_ALLOWED — a ativação
 *      agora é por serviço (`POST .../activate-recruitment`, spec própria em
 *      `activation.e2e.test.ts`), nunca mais um pulo direto do Kanban. Movimento DENTRO do funil
 *      continua livre (SOLICITANTE → ADMISSION → PENDING_ADMISSION grava e admission_status
 *      acompanha). Chegar a ACTIVE de verdade passa por SEARCHING (activate-recruitment) e só
 *      depois `PUT /status` SEARCHING → ACTIVE, que o catálogo 315 nunca removeu;
 *   7. DISCHARGED/SUSPENDED não apagam linha nenhuma (lex C7.4): contagem antes/depois;
 *   8. a ficha (GET /:id) devolve admissionStatus/onHoldReason/onHoldNote; a nota nunca vai ao log
 *      do banco (patient_status_history não a tem);
 *   9. SUSPENDED → SEARCHING sem motivo: 422 SUSPENSION_EXIT_REASON_REQUIRED, nada muda; com
 *      motivo: 200, history com reason + actor_uid preenchidos (migration 486); SUSPENDED →
 *      REPLACEMENT e → ON_HOLD (com onHoldReason também) aceitos.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { semearFaixas } from './helpers/seedFaixaDoServico';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';
import { seedPatientStatus } from './helpers/seedPatientStatus';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const UID = 'ps-v2-admin-uid';
const NOTE = 'La obra social no autorizó — nota clínica e2e 3b7d';

describe('Estado do paciente v2 — transições, motivo, Historial (spec 012 US-B7) @integration', () => {
  const api = createApiClient();
  // `asAdmin.uid` (não o `UID` pedido): com o emulador de pé, o uid EFETIVO é o localId dele —
  // ver comentário de `staffAuth`. É esse que `PatientStatusWriter` grava em `actor_uid`.
  let asAdmin: StaffAuth;
  let pool: Pool;
  let active = '';
  let lead = '';
  let lead2 = '';
  let leadServiceId = '';

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(UID, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE 'ps-v2-e2e-%')`,
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'ps-v2-e2e-%'`);
    active = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('ps-v2-e2e-1', 'Estado', 'Activo', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
    lead = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('ps-v2-e2e-2', 'Estado', 'Lead', 'AR', 'SOLICITANTE') RETURNING id`,
    )).rows[0].id;
    // Paciente extra só para o teste 6 (SOLICITANTE → ACTIVE direto, bloqueado pela 428) — não
    // precisa de endereço/serviço porque a checagem de transição roda ANTES da de completude.
    lead2 = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('ps-v2-e2e-3', 'Estado', 'Lead2', 'AR', 'SOLICITANTE') RETURNING id`,
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
      const svc = (await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services
           (patient_id, service_code, active, country, created_by, updated_by, address_id,
            required_professions, required_sex, required_experience, work_schedule, payment_day)
         -- spec 027 Fase 3: os 5 campos do portão "ativar recrutamento" (D508 c)
         VALUES ($1,'AT',true,'AR','ps-v2-e2e','ps-v2-e2e',$2,
                 ARRAY['AT'],'BOTH','EXP-E2E','part-time','DIA-E2E') RETURNING id`,
        [id, addr],
      )).rows[0].id;
      await semearFaixas(pool, svc, [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], 'ps-v2-e2e'); // spec 056: o horário é faixa em patient_itinerary_slot
      if (id === lead) leadServiceId = svc;
    }
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE 'ps-v2-e2e-%')`,
    );
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

  it('2. F5: destino derivado pelo PUT (ON_HOLD → REPLACEMENT) → 422 PATIENT_STATUS_NOT_MANUAL; status e trilha não mudam', async () => {
    const trilha = async () => Number((await pool.query(`SELECT count(*) AS n FROM patient_status_history WHERE patient_id = $1`, [active])).rows[0].n);
    const antes = await trilha();
    const r = await api.put(`/api/admin/patients/${active}/status`, { status: 'REPLACEMENT' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ success: false, code: 'PATIENT_STATUS_NOT_MANUAL', details: { to: 'REPLACEMENT', changeSource: 'admin_panel' } });
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [active])).rows[0].status).toBe('ON_HOLD');
    expect(await trilha()).toBe(antes);
  });

  it('3. ON_HOLD sem motivo → 422 ON_HOLD_REASON_REQUIRED; motivo fora do enum → 400', async () => {
    const r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('ON_HOLD_REASON_REQUIRED');
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', onHoldReason: 'BUDGET' }, asAdmin)).status).toBe(400);
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'DISCONTINUED' }, asAdmin)).status).toBe(400);
  });

  it('4. GET /status-history: quando / de→para / origem / motivo / autor — sem nota', async () => {
    const r = await api.get(`/api/admin/patients/${active}/status-history`, asAdmin);
    expect(r.status).toBe(200);
    const h = r.data.data.history as Array<Record<string, unknown>>;
    // migration 486: mudança via HTTP grava o autor; não é saída de SUSPENDED → reason null.
    expect(h[0]).toMatchObject({ from: 'ACTIVE', to: 'ON_HOLD', source: 'admin_panel', reason: null, actorUid: asAdmin.uid });
    expect(typeof h[0].at).toBe('string');
    // a linha inicial do INSERT (trigger 255) está lá também — sem ator (mudança de sistema).
    expect(h[h.length - 1]).toMatchObject({ from: null, to: 'ACTIVE', source: 'insert', reason: null, actorUid: null });
    const raw = JSON.stringify(r.data);
    expect(raw).not.toContain(NOTE);
  });

  it('5. ON_HOLD → ALTA limpa motivo e nota (nenhuma segunda cópia); ON_HOLD → ACTIVE pelo PUT é recusado (NOT_MANUAL); ficha devolve os campos v2', async () => {
    const refused = await api.put(`/api/admin/patients/${active}/status`, { status: 'ACTIVE' }, asAdmin);
    expect(refused.status).toBe(422);
    expect(refused.data.code).toBe('PATIENT_STATUS_NOT_MANUAL');
    // recusa antes de tudo: motivo e nota continuam lá (controle positivo da limpeza abaixo)
    expect((await pool.query(`SELECT status, on_hold_reason FROM patients WHERE id = $1`, [active])).rows[0]).toEqual({ status: 'ON_HOLD', on_hold_reason: 'INSURER' });

    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'ALTA' }, asAdmin)).status).toBe(200);
    const { rows: [row] } = await pool.query(`SELECT status, on_hold_reason, on_hold_note FROM patients WHERE id = $1`, [active]);
    expect(row).toEqual({ status: 'ALTA', on_hold_reason: null, on_hold_note: null });

    // volta a ACTIVE por SQL (estado derivado não se monta pelo PUT depois da F5)
    await seedPatientStatus(pool, active, 'ACTIVE');
    const g = await api.get(`/api/admin/patients/${active}`, asAdmin);
    expect(g.status).toBe(200);
    expect(g.data.data).toMatchObject({ status: 'ACTIVE', admissionStatus: 'DONE', onHoldReason: null, onHoldNote: null, serviceStartDate: null });
  });

  it('6. F5: kanban pede QUALQUER destino → 422 NOT_MANUAL; funil→ACTIVE direto idem; dentro do funil só admin_panel; ACTIVE de verdade só via activate-recruitment (SEARCHING) e a troca daí em diante é derivada', async () => {
    const trilha = async (id: string) => Number((await pool.query(`SELECT count(*) AS n FROM patient_status_history WHERE patient_id = $1`, [id])).rows[0].n);
    const notManual = (r: { status: number; data: any }, to: string, changeSource: string) => {
      expect(r.status).toBe(422);
      expect(r.data).toMatchObject({ success: false, code: 'PATIENT_STATUS_NOT_MANUAL', details: { to, changeSource } });
    };

    // 6a. kanban: SOLICITANTE → ACTIVE (destino derivado) e SOLICITANTE → ADMISSION (destino do funil) — ambos recusados.
    const t0 = await trilha(lead2);
    notManual(await api.put(`/api/admin/patients/${lead2}/status`, { status: 'ACTIVE', changeSource: 'kanban' }, asAdmin), 'ACTIVE', 'kanban');
    notManual(await api.put(`/api/admin/patients/${lead2}/status`, { status: 'ADMISSION', changeSource: 'kanban' }, asAdmin), 'ADMISSION', 'kanban');
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [lead2])).rows[0].status).toBe('SOLICITANTE');
    expect(await trilha(lead2)).toBe(t0);

    // 6b. lead: SOLICITANTE → ADMISSION pelo admin_panel continua livre (movimento DENTRO do funil).
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'ADMISSION' }, asAdmin)).status).toBe(200);
    let row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'ADMISSION', admission_status: 'ADMISSION' });

    // 6c. ADMISSION → ACTIVE direto (admin_panel e kanban) — recusado e o estado fica.
    notManual(await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE' }, asAdmin), 'ACTIVE', 'admin_panel');
    notManual(await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE', changeSource: 'kanban' }, asAdmin), 'ACTIVE', 'kanban');
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'ADMISSION', admission_status: 'ADMISSION' });

    // 6d. ADMISSION → PENDING_ADMISSION pelo admin_panel continua livre (ainda dentro do funil).
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'PENDING_ADMISSION' }, asAdmin)).status).toBe(200);
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'PENDING_ADMISSION', admission_status: 'PENDING_ADMISSION' });

    // 6e. PENDING_ADMISSION → ACTIVE e → SEARCHING pelo PUT: recusados (SEARCHING só pelo foguete).
    notManual(await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE' }, asAdmin), 'ACTIVE', 'admin_panel');
    notManual(await api.put(`/api/admin/patients/${lead}/status`, { status: 'SEARCHING' }, asAdmin), 'SEARCHING', 'admin_panel');
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'PENDING_ADMISSION', admission_status: 'PENDING_ADMISSION' });

    // 6f. Caminho real: activate-recruitment (foguete) cria a vaga em rascunho E move para SEARCHING
    // (changeSource 'recruitment_activation'). Daí em diante SEARCHING → ACTIVE NÃO é troca manual.
    await pool.query(`UPDATE patients SET insurance_informed = 'Particular' WHERE id = $1`, [lead]);
    await seedPatientDiagnosis(pool, lead);
    const activated = await api.post(`/api/admin/patients/${lead}/contracted-services/${leadServiceId}/activate-recruitment`, {}, asAdmin);
    expect(activated.status).toBe(201);
    expect(activated.data.data.patientStatus).toBe('SEARCHING');
    expect(activated.data.data.statusChanged).toBe(true);
    row = (await pool.query(`SELECT status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'SEARCHING' });
    const hist = (await api.get(`/api/admin/patients/${lead}/status-history`, asAdmin)).data.data.history as Array<Record<string, unknown>>;
    expect(hist[0]).toMatchObject({ to: 'SEARCHING', source: 'recruitment_activation' });

    const t1 = await trilha(lead);
    notManual(await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE', changeSource: 'kanban' }, asAdmin), 'ACTIVE', 'kanban');
    notManual(await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE' }, asAdmin), 'ACTIVE', 'admin_panel');
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [lead])).rows[0].status).toBe('SEARCHING');
    expect(await trilha(lead)).toBe(t1);

    // seed para o teste 7: ACTIVE por SQL (o estado derivado não é montado pelo PUT)
    await seedPatientStatus(pool, lead, 'ACTIVE');
    expect((await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0]).toEqual({ status: 'ACTIVE', admission_status: 'DONE' });
  });

  it('7. DISCHARGED e SUSPENDED não apagam linha nenhuma (lex C7.4)', async () => {
    const count = async () => Number((await pool.query(`SELECT count(*) AS n FROM patients WHERE clickup_task_id LIKE 'ps-v2-e2e-%'`)).rows[0].n);
    const before = await count();
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'SUSPENDED' }, asAdmin)).status).toBe(200);
    // Migration 486 (decisão do Gabriel 29/09/2026): SAIR de SUSPENDED manualmente exige motivo
    // — DISCHARGED não é exceção (o writer não distingue o alvo). Sem o `suspensionExitReason`
    // aqui, este teste vermelho foi o que ACUSOU a régua nova (achado deste fecho).
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'DISCHARGED', suspensionExitReason: 'WRONG_STATUS' }, asAdmin)).status).toBe(200);
    expect(await count()).toBe(before);
    expect((await pool.query(`SELECT deleted_at FROM patients WHERE id = $1`, [lead])).rows[0].deleted_at).toBeNull();
    // F5: o resgate DISCHARGED → ACTIVE não é mais troca manual (vira ação `reactivate`, coberta em patient-status-acoes)
    const r = await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_STATUS_NOT_MANUAL');
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [lead])).rows[0].status).toBe('DISCHARGED');
    await seedPatientStatus(pool, lead, 'ACTIVE'); // o teste 8 lê admissionStatus DONE dos dois
  });

  it('8. listagem devolve admissionStatus (o que o Kanban lê)', async () => {
    const r = await api.get(`/api/admin/patients?search=Estado&limit=50`, asAdmin);
    expect(r.status).toBe(200);
    const mine = (r.data.data as Array<{ id: string; admissionStatus: string }>).filter((p) => p.id === active || p.id === lead);
    expect(mine.map((p) => p.admissionStatus)).toEqual(['DONE', 'DONE']);
  });

  // ── 9. Saída de SUSPENDED com motivo (migration 486, decisão do Gabriel 29/09/2026) ────────────
  it('9. F5: SUSPENDED → SEARCHING/REPLACEMENT pelo PUT é NOT_MANUAL (com ou sem motivo); SUSPENDED → ON_HOLD exige os DOIS motivos e grava reason + actor_uid', async () => {
    // `active` está em ACTIVE (teste 5 devolveu por SQL) — ACTIVE → SUSPENDED é manual e livre.
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'SUSPENDED' }, asAdmin)).status).toBe(200);
    const trilha = async () => Number((await pool.query(`SELECT count(*) AS n FROM patient_status_history WHERE patient_id = $1`, [active])).rows[0].n);
    const antes = await trilha();

    // 9a. destino derivado: recusa ANTES da régua do motivo — mesmo sem suspensionExitReason o código é NOT_MANUAL.
    for (const body of [
      { status: 'SEARCHING' },
      { status: 'SEARCHING', suspensionExitReason: 'RESUMED_SERVICE' },
      { status: 'REPLACEMENT', suspensionExitReason: 'NEEDS_NEW_WORKER' },
    ]) {
      const r = await api.put(`/api/admin/patients/${active}/status`, body, asAdmin);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('PATIENT_STATUS_NOT_MANUAL');
    }
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [active])).rows[0].status).toBe('SUSPENDED');
    expect(await trilha()).toBe(antes);

    // 9b. SUSPENDED → ON_HOLD exige OS DOIS motivos; motivo fora do enum → 400 (zod).
    let r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', suspensionExitReason: 'OTHER' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('ON_HOLD_REASON_REQUIRED');
    r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', onHoldReason: 'SCHOOL' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('SUSPENSION_EXIT_REASON_REQUIRED');
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', onHoldReason: 'SCHOOL', suspensionExitReason: 'PORQUE_SI' }, asAdmin)).status).toBe(400);
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [active])).rows[0].status).toBe('SUSPENDED');

    // 9c. com os dois → 200; history com reason + actor_uid (migration 486).
    r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', onHoldReason: 'SCHOOL', suspensionExitReason: 'OTHER' }, asAdmin);
    expect(r.status).toBe(200);
    const hist = (await api.get(`/api/admin/patients/${active}/status-history`, asAdmin)).data.data.history as Array<Record<string, unknown>>;
    expect(hist[0]).toMatchObject({ from: 'SUSPENDED', to: 'ON_HOLD', source: 'admin_panel', reason: 'OTHER', actorUid: asAdmin.uid });

    // resgate por SQL (derivado não se monta pelo PUT) — este é o último teste do arquivo.
    await seedPatientStatus(pool, active, 'ACTIVE');
  });
});
