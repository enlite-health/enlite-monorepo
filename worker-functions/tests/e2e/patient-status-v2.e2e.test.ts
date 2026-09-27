/**
 * patient-status-v2.e2e.test.ts @integration — spec 012, US-B7 (estado v2, motivo, Historial)
 *
 * API real (Docker, USE_MOCK_AUTH) + Postgres real com as migrations 313-315. O que prova:
 *   1. transição PERMITIDA (ACTIVE → ON_HOLD com motivo) → 200; banco com on_hold_reason/note;
 *      patient_status_history ganha a linha com change_source='admin_panel' (trigger 254 + set_config);
 *      admission_status continua DONE (trigger 313);
 *   2. transição PROIBIDA (ON_HOLD → REPLACEMENT, fora do seed da 315) → 422 com código de enum;
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
           (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ($1,'AT',true,'AR','ps-v2-e2e','ps-v2-e2e',$2,
                 '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]'::jsonb) RETURNING id`,
        [id, addr],
      )).rows[0].id;
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

  it('5. ON_HOLD → ACTIVE limpa motivo e nota; ficha devolve os campos v2', async () => {
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'ACTIVE' }, asAdmin)).status).toBe(200);
    const { rows: [row] } = await pool.query(`SELECT status, on_hold_reason, on_hold_note FROM patients WHERE id = $1`, [active]);
    expect(row).toEqual({ status: 'ACTIVE', on_hold_reason: null, on_hold_note: null });
    const g = await api.get(`/api/admin/patients/${active}`, asAdmin);
    expect(g.status).toBe(200);
    expect(g.data.data).toMatchObject({ status: 'ACTIVE', admissionStatus: 'DONE', onHoldReason: null, onHoldNote: null, serviceStartDate: null });
  });

  it('6. Migration 428: funil→ACTIVE direto é 422 nas TRÊS origens; dentro do funil continua livre; ACTIVE de verdade só via SEARCHING (lançamento da vaga)', async () => {
    // 6a. SOLICITANTE → ACTIVE direto (lead2, nunca tocado por outro teste) — bloqueado.
    let r = await api.put(`/api/admin/patients/${lead2}/status`, { status: 'ACTIVE', changeSource: 'kanban' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({
      success: false,
      code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED',
      details: { from: 'SOLICITANTE', to: 'ACTIVE' },
    });
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [lead2])).rows[0].status).toBe('SOLICITANTE');

    // 6b. lead: SOLICITANTE → ADMISSION continua livre (movimento DENTRO do funil).
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'ADMISSION', changeSource: 'kanban' }, asAdmin)).status).toBe(200);
    let row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'ADMISSION', admission_status: 'ADMISSION' });

    // 6c. ADMISSION → ACTIVE direto — bloqueado (era a linha removida pela 428).
    r = await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE', changeSource: 'kanban' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({
      success: false,
      code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED',
      details: { from: 'ADMISSION', to: 'ACTIVE' },
    });
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'ADMISSION', admission_status: 'ADMISSION' });

    // 6d. ADMISSION → PENDING_ADMISSION continua livre (ainda dentro do funil).
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'PENDING_ADMISSION', changeSource: 'kanban' }, asAdmin)).status).toBe(200);
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'PENDING_ADMISSION', admission_status: 'PENDING_ADMISSION' });

    // 6e. PENDING_ADMISSION → ACTIVE direto — bloqueado (a 3ª linha que a 428 removeu).
    r = await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE', changeSource: 'kanban' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({
      success: false,
      code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED',
      details: { from: 'PENDING_ADMISSION', to: 'ACTIVE' },
    });
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'PENDING_ADMISSION', admission_status: 'PENDING_ADMISSION' });

    // 6f. Caminho real: COVERAGE informada (endereço/horário do serviço já vêm do beforeAll) →
    // activate-recruitment cria a vaga em rascunho e NÃO move o paciente (DX-6.6) — quem move
    // o funil para SEARCHING é o lançamento à Talentum (D434), coberto por
    // `funil-vacante-lancamento` (Playwright + stub), fora do alcance deste teste. PUT /status
    // funil → SEARCHING pelo Kanban é 422 (a guarda da DX-6.4). Daqui em diante semeamos
    // SEARCHING por SQL só para continuar cobrindo SEARCHING → ACTIVE (catálogo 315, a 428
    // nunca tocou essa linha).
    await pool.query(`UPDATE patients SET health_insurance_name = 'Particular' WHERE id = $1`, [lead]);
    const activated = await api.post(`/api/admin/patients/${lead}/contracted-services/${leadServiceId}/activate-recruitment`, {}, asAdmin);
    expect(activated.status).toBe(201);
    expect(activated.data.data.patientStatus).toBe('PENDING_ADMISSION');
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'PENDING_ADMISSION', admission_status: 'PENDING_ADMISSION' });

    // guarda da DX-6.4: só o lançamento (changeSource 'vacancy_launch') pode usar funil → SEARCHING.
    r = await api.put(`/api/admin/patients/${lead}/status`, { status: 'SEARCHING', changeSource: 'kanban' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({
      success: false,
      code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED',
      details: { from: 'PENDING_ADMISSION', to: 'SEARCHING' },
    });

    await pool.query(`UPDATE patients SET status = 'SEARCHING' WHERE id = $1`, [lead]);

    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE', changeSource: 'kanban' }, asAdmin)).status).toBe(200);
    row = (await pool.query(`SELECT status, admission_status FROM patients WHERE id = $1`, [lead])).rows[0];
    expect(row).toEqual({ status: 'ACTIVE', admission_status: 'DONE' });
    const hist = (await api.get(`/api/admin/patients/${lead}/status-history`, asAdmin)).data.data.history as Array<Record<string, unknown>>;
    expect(hist[0]).toMatchObject({ from: 'SEARCHING', to: 'ACTIVE', source: 'kanban' });
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
    // resgate (#REGRA-07): DISCHARGED → ACTIVE está no seed
    expect((await api.put(`/api/admin/patients/${lead}/status`, { status: 'ACTIVE' }, asAdmin)).status).toBe(200);
  });

  it('8. listagem devolve admissionStatus (o que o Kanban lê)', async () => {
    const r = await api.get(`/api/admin/patients?search=Estado&limit=50`, asAdmin);
    expect(r.status).toBe(200);
    const mine = (r.data.data as Array<{ id: string; admissionStatus: string }>).filter((p) => p.id === active || p.id === lead);
    expect(mine.map((p) => p.admissionStatus)).toEqual(['DONE', 'DONE']);
  });

  // ── 9. Saída de SUSPENDED com motivo (migration 486, decisão do Gabriel 29/09/2026) ────────────
  it('9. SUSPENDED → SEARCHING sem motivo: 422; com motivo: 200 + history com reason/actor_uid; REPLACEMENT e ON_HOLD também aceitos', async () => {
    // `active` está em ACTIVE (teste 5 devolveu) — leva a SUSPENDED primeiro.
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'SUSPENDED' }, asAdmin)).status).toBe(200);

    // 9a. sem motivo → 422, nada muda.
    let r = await api.put(`/api/admin/patients/${active}/status`, { status: 'SEARCHING' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('SUSPENSION_EXIT_REASON_REQUIRED');
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [active])).rows[0].status).toBe('SUSPENDED');

    // 9b. motivo fora do enum → 400 (zod).
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'SEARCHING', suspensionExitReason: 'PORQUE_SI' }, asAdmin)).status).toBe(400);

    // 9c. com motivo → 200; banco e history com reason + actor_uid.
    r = await api.put(`/api/admin/patients/${active}/status`, { status: 'SEARCHING', suspensionExitReason: 'RESUMED_SERVICE' }, asAdmin);
    expect(r.status).toBe(200);
    const hist = (await api.get(`/api/admin/patients/${active}/status-history`, asAdmin)).data.data.history as Array<Record<string, unknown>>;
    expect(hist[0]).toMatchObject({
      from: 'SUSPENDED', to: 'SEARCHING', source: 'admin_panel', reason: 'RESUMED_SERVICE', actorUid: asAdmin.uid,
    });

    // 9d. SUSPENDED → REPLACEMENT com motivo. `active` está em SEARCHING (9c) e o catálogo (315)
    // não tem `SEARCHING → SUSPENDED` direto (só ACTIVE/REPLACEMENT entram em SUSPENDED) —
    // detour por ACTIVE (catálogo 315 + checklist já satisfeito desde o beforeAll) para voltar
    // a SUSPENDED sem inventar uma transição que a 315 nunca abriu.
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'ACTIVE' }, asAdmin)).status).toBe(200);
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'SUSPENDED' }, asAdmin)).status).toBe(200);
    r = await api.put(`/api/admin/patients/${active}/status`, { status: 'REPLACEMENT', suspensionExitReason: 'NEEDS_NEW_WORKER' }, asAdmin);
    expect(r.status).toBe(200);

    // 9e. SUSPENDED → ON_HOLD exige OS DOIS motivos (onHoldReason continua obrigatório).
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'SUSPENDED' }, asAdmin)).status).toBe(200);
    r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', suspensionExitReason: 'OTHER' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('ON_HOLD_REASON_REQUIRED');
    r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', onHoldReason: 'SCHOOL' }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('SUSPENSION_EXIT_REASON_REQUIRED');
    r = await api.put(`/api/admin/patients/${active}/status`, { status: 'ON_HOLD', onHoldReason: 'SCHOOL', suspensionExitReason: 'OTHER' }, asAdmin);
    expect(r.status).toBe(200);

    // resgate: devolve `active` para ACTIVE (não afeta outro teste — este é o último do arquivo).
    expect((await api.put(`/api/admin/patients/${active}/status`, { status: 'ACTIVE' }, asAdmin)).status).toBe(200);
  });
});
