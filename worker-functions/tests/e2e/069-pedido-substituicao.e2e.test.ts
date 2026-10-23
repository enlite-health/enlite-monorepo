/**
 * 069-pedido-substituicao.e2e.test.ts @integration — spec 069, F2 (parte DIAS) e F3 (parte PERMANENTE, desfazer, "Elegir quién entra").
 *
 * A parte F3 é o 2º `describe` do arquivo (semente `seedB2`): "No vuelve más" a partir de D com titular em 2 faixas, sem e com
 * substituto, FR-23, P5, destino (P6), desfazer antes de D (ORDEM: cancela a entrada ANTES de soltar o fim do titular — Trava A),
 * desfazer de pedido todo passado (409) e "Elegir quién entra". Nada é mock: tudo pela API HTTP real + Postgres real.
 *
 * Prova, contra a API REAL de pé + Postgres real, o pedido de substituição por dias:
 *   GET  .../contracted-services/:sid/substitution-requests/outgoing-options  (¿Quién no va a venir?)
 *   POST .../substitution-requests/preview   (turnos derivados, conflito tri-estado)
 *   POST .../substitution-requests           (UMA transação: cabeçalho → N ausências → N registros ABSENCE)
 *   GET  .../substitution-requests?when=...  (a aba "Sustituciones")
 *
 * O que NÃO é mock: a alocação e o pedido passam pela API HTTP real (`staffAuth`); só a semente de worker/vaga/candidatura/faixa é
 * SQL direto (molde `patient-itinerary-events-and-replace.e2e.test.ts`). Datas SEMPRE do banco (Buenos Aires), nunca do relógio do
 * runner. Cada "nenhuma escrita parcial" é provada por CONTAGEM antes × depois com controle positivo (o mesmo comando, sem a
 * violação, grava).
 *
 * Titular com seg/qua/sex: período de 12 dias a partir de uma segunda = 6 turnos (seg, qua, sex, seg, qua, sex).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { seedB2, limparB2, hojeAr, somaDias, proximoDia, type SeedB2 } from './helpers/seedItinerarioB2';
import { seedRequestForAssignment } from './helpers/seedSubstitutionRequest';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `ps069-${RUN}-`;
const SEG = 1;
const QUA = 3;
const SEX = 5;

interface Shift {
  date: string;
  slotId: string;
  assignmentId: string;
  startTime: string;
  endTime: string;
}

describe('069 · pedido de substituição por dias — API real @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;

  let patientId = '';
  let addressId = '';
  let serviceId = '';
  let jobId = '';
  let titular = '';
  let sub = '';
  let sub2 = '';
  let intruso = '';
  const slotIds: Record<number, string> = {};
  let hoje = '';
  let nextMonday = '';

  const extraServiceIds: string[] = [];
  const extraJobIds: string[] = [];

  const baseUrl = (sid = serviceId): string => `/api/admin/patients/${patientId}/contracted-services/${sid}/substitution-requests`;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
  const addDays = async (date: string, days: number): Promise<string> => (await q<{ d: string }>(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [date, days]))[0].d;

  async function mkWorker(label: string, job = jobId): Promise<string> {
    const workerId = (
      await q<{ id: string }>(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`, [`${PREFIX}${label}`, `${PREFIX}${label}@e2e.local`])
    )[0].id;
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'import')`,
      [workerId, job],
    );
    return workerId;
  }

  async function mkSlot(sid: string, weekday: number, start: string, minutes: number): Promise<string> {
    return (
      await q<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '[2026-01-01,)', $5, $5) RETURNING id`,
        [sid, weekday, start, minutes, PREFIX],
      )
    )[0].id;
  }

  async function mkExtraService(label: string): Promise<{ sid: string; job: string }> {
    const sid = (
      await q<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by) VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patientId, addressId, PREFIX],
      )
    )[0].id;
    const job = (await q<{ id: string }>(`INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`, [`${PREFIX}vaga-${label}`, sid, patientId]))[0].id;
    extraServiceIds.push(sid);
    extraJobIds.push(job);
    return { sid, job };
  }

  async function allocate(sid: string, slotId: string, workerId: string): Promise<string> {
    const res = await api.post(`/api/admin/patients/${patientId}/contracted-services/${sid}/itinerary/slots/${slotId}/allocations`, { workerId }, { headers: asAdmin.headers });
    expect(res.status).toBe(201);
    return res.data.data.allocationId as string;
  }

  /** Contagens do serviço: cabeçalhos, ausências e registros ABSENCE ligados a pedido. */
  async function counts(sid = serviceId): Promise<{ headers: number; absences: number; logs: number }> {
    const r = await q<{ headers: number; absences: number; logs: number }>(
      `SELECT (SELECT count(*) FROM patient_itinerary_substitution_request WHERE contracted_service_id = $1)::int AS headers,
              (SELECT count(*) FROM patient_itinerary_absence ab JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
                 JOIN patient_itinerary_slot s ON s.id = a.slot_id WHERE s.contracted_service_id = $1)::int AS absences,
              (SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = $1 AND request_id IS NOT NULL)::int AS logs`,
      [sid],
    );
    return r[0];
  }

  /** O corpo do create para um período, com os turnos DERIVADOS pela pré-visão (a tela faz o mesmo) e o substituto escolhido por turno. */
  async function shiftsOf(from: string, to: string, candidate: string): Promise<Shift[]> {
    const res = await api.post(`${baseUrl()}/preview`, { type: 'DAYS', outgoingWorkerId: titular, from, to, candidateWorkerIds: [candidate] }, { headers: asAdmin.headers });
    expect(res.status).toBe(200);
    return res.data.data.shifts as Shift[];
  }
  const body = (from: string, to: string, shifts: Shift[], substitute: string | null, extra: Record<string, unknown> = {}) => ({
    type: 'DAYS', outgoingWorkerId: titular, from, to, reasonCategory: 'OTHER',
    shifts: shifts.map((s) => ({ date: s.date, slotId: s.slotId, substituteWorkerId: substitute })), ...extra,
  });

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`ps069-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });

    patientId = (await q<{ id: string }>(`INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'Pedido', 'Sustitucion', 'AR', 'ACTIVE') RETURNING id`, [`${PREFIX}p1`]))[0].id;
    addressId = (await q<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`, [patientId]))[0].id;
    serviceId = (
      await q<{ id: string }>(`INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by) VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`, [patientId, addressId, PREFIX])
    )[0].id;
    jobId = (await q<{ id: string }>(`INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`, [`${PREFIX}vaga`, serviceId, patientId]))[0].id;

    hoje = (await q<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS d`))[0].d;
    nextMonday = (
      await q<{ d: string }>(
        `SELECT to_char(g::date, 'YYYY-MM-DD') AS d FROM generate_series(($1::date + 1), ($1::date + 7), interval '1 day') g WHERE extract(dow FROM g) = 1`,
        [hoje],
      )
    )[0].d;

    slotIds[SEG] = await mkSlot(serviceId, SEG, '08:00', 240);
    slotIds[QUA] = await mkSlot(serviceId, QUA, '08:00', 240);
    slotIds[SEX] = await mkSlot(serviceId, SEX, '08:00', 240);

    titular = await mkWorker('titular');
    sub = await mkWorker('sub');
    sub2 = await mkWorker('sub2');
    intruso = await mkWorker('intruso'); // candidato no serviço, SEM alocação
    for (const weekday of [SEG, QUA, SEX]) await allocate(serviceId, slotIds[weekday], titular);
  });

  afterAll(async () => {
    const sids = [serviceId, ...extraServiceIds];
    await pool.query(`DELETE FROM patient_itinerary_change_log WHERE contracted_service_id = ANY($1::uuid[])`, [sids]);
    await pool.query(
      `DELETE FROM patient_itinerary_absence ab USING patient_itinerary_assignment a, patient_itinerary_slot s
        WHERE ab.assignment_id = a.id AND a.slot_id = s.id AND s.contracted_service_id = ANY($1::uuid[])`,
      [sids],
    );
    await pool.query(`DELETE FROM patient_itinerary_substitution_request WHERE contracted_service_id = ANY($1::uuid[])`, [sids]);
    await pool.query(`DELETE FROM patient_itinerary_assignment a USING patient_itinerary_slot s WHERE a.slot_id = s.id AND s.contracted_service_id = ANY($1::uuid[])`, [sids]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [[jobId, ...extraJobIds]]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${PREFIX}%`]);
    await pool.end();
  });

  // ── ¿Quién no va a venir? ──────────────────────────────────────────────────────────────────────
  it('US3: a pessoa com 3 faixas aparece em UMA linha; quem não tem alocação neste serviço não aparece', async () => {
    const res = await api.get(`${baseUrl()}/outgoing-options`, { headers: asAdmin.headers });
    expect(res.status).toBe(200);
    const workers = res.data.data.workers as Array<{ workerId: string }>;
    expect(workers.filter((w) => w.workerId === titular)).toHaveLength(1); // controle positivo: o titular (3 faixas) está, 1×
    expect(workers.some((w) => w.workerId === intruso)).toBe(false);
    expect(workers.some((w) => w.workerId === sub)).toBe(false);
  });

  // ── pré-visão ──────────────────────────────────────────────────────────────────────────────────
  it('pré-visão: Varios días = 6 turnos derivados no servidor; conflito livre; NADA gravado', async () => {
    const to = await addDays(nextMonday, 11);
    const antes = await counts();
    const res = await api.post(`${baseUrl()}/preview`, { type: 'DAYS', outgoingWorkerId: titular, from: nextMonday, to, candidateWorkerIds: [sub] }, { headers: asAdmin.headers });
    expect(res.status).toBe(200);
    const data = res.data.data as { shifts: Shift[]; conflicts: Array<{ workerId: string; state: string }>; statusAfter: { changes: boolean } | null };
    const esperadas = await Promise.all([0, 2, 4, 7, 9, 11].map((n) => addDays(nextMonday, n))); // seg, qua, sex, seg, qua, sex
    expect(data.shifts.map((s) => s.date)).toEqual(esperadas);
    expect(data.conflicts).toHaveLength(6);
    expect(data.conflicts.every((c) => c.workerId === sub && c.state === 'free')).toBe(true);
    expect(data.statusAfter === null || data.statusAfter.changes === false).toBe(true);
    expect(await counts()).toEqual(antes); // LEITURA: nenhuma escrita
  });

  it('pré-visão de um período sem turno da pessoa → 422 SUBSTITUTION_NO_SHIFTS_IN_PERIOD; data passada → 422 ABSENCE_DATE_IN_PAST', async () => {
    const terca = await addDays(nextMonday, 1);
    const semTurno = await api.post(`${baseUrl()}/preview`, { type: 'ONE_DAY', outgoingWorkerId: titular, from: terca, candidateWorkerIds: [] }, { headers: asAdmin.headers });
    expect(semTurno.status).toBe(422);
    expect(semTurno.data.code).toBe('SUBSTITUTION_NO_SHIFTS_IN_PERIOD');
    const passada = await api.post(`${baseUrl()}/preview`, { type: 'ONE_DAY', outgoingWorkerId: titular, from: await addDays(hoje, -3), candidateWorkerIds: [] }, { headers: asAdmin.headers });
    expect(passada.status).toBe(422);
    expect(passada.data.code).toBe('ABSENCE_DATE_IN_PAST');
  });

  // ── create: o caminho feliz ────────────────────────────────────────────────────────────────────
  it('US4 aceite 1 + FR-11: Varios días com titular seg/qua/sex → 6 ausências + 6 ABSENCE com o MESMO request_id, num cabeçalho só', async () => {
    const to = await addDays(nextMonday, 11);
    const shifts = await shiftsOf(nextMonday, to, sub);
    expect(shifts).toHaveLength(6);
    const antes = await counts();

    const res = await api.post(baseUrl(), body(nextMonday, to, shifts, sub), { headers: asAdmin.headers });

    expect(res.status).toBe(201);
    const requestId = res.data.data.requestId as string;
    expect(res.data.data).toMatchObject({ type: 'DAYS', from: nextMonday, to, shiftCount: 6 });
    expect(await counts()).toEqual({ headers: antes.headers + 1, absences: antes.absences + 6, logs: antes.logs + 6 });

    const absences = await q<{ request_id: string; substitute_worker_id: string }>(
      `SELECT ab.request_id, ab.substitute_worker_id FROM patient_itinerary_absence ab WHERE ab.request_id = $1`, [requestId]);
    expect(absences).toHaveLength(6);
    expect(absences.every((a) => a.request_id === requestId && a.substitute_worker_id === sub)).toBe(true);
    const logs = await q<{ kind: string; request_id: string; absence_id: string }>(`SELECT kind, request_id, absence_id FROM patient_itinerary_change_log WHERE request_id = $1`, [requestId]);
    expect(logs).toHaveLength(6);
    expect(logs.every((l) => l.kind === 'ABSENCE' && l.absence_id !== null)).toBe(true);

    // a agenda lê o pedido: as 6 ocorrências saem `substituted` com o mesmo requestId
    const events = await api.get(`/api/admin/patients/${patientId}/itinerary/events?from=${nextMonday}&to=${to}&serviceId=${serviceId}`, { headers: asAdmin.headers });
    const substituted = (events.data.data.events as Array<{ status: string; requestId: string | null }>).filter((e) => e.status === 'substituted');
    expect(substituted).toHaveLength(6);
    expect(substituted.every((e) => e.requestId === requestId)).toBe(true);

    // a aba "Sustituciones": UMA linha, 6 turnos, Entra = a pessoa que cobre
    const list = await api.get(`${baseUrl()}?when=upcoming`, { headers: asAdmin.headers });
    expect(list.status).toBe(200);
    const mine = (list.data.data.requests as Array<{ requestId: string; type: string; shiftCount: number; entra: { kind: string; workerIds: string[] }; outgoingWorkerId: string; reasonCode: string; undoable: boolean }>).filter((r) => r.requestId === requestId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: 'DAYS', shiftCount: 6, outgoingWorkerId: titular, reasonCode: 'OTHER', undoable: true });
    expect(mine[0].entra).toMatchObject({ kind: 'PERSON', workerIds: [sub] });
    const passadas = await api.get(`${baseUrl()}?when=past`, { headers: asAdmin.headers });
    expect((passadas.data.data.requests as Array<{ requestId: string }>).some((r) => r.requestId === requestId)).toBe(false);
  });

  it('"Nadie todavía" por turno: substituteWorkerId null grava ausência SEM substituto (Sin cubrir) e a lista mostra NOBODY', async () => {
    const from = await addDays(nextMonday, 28);
    const shifts = await shiftsOf(from, from, sub);
    expect(shifts).toHaveLength(1);
    const res = await api.post(baseUrl(), { type: 'ONE_DAY', outgoingWorkerId: titular, from, reasonCategory: 'OTHER', shifts: [{ date: shifts[0].date, slotId: shifts[0].slotId, substituteWorkerId: null }] }, { headers: asAdmin.headers });
    expect(res.status).toBe(201);
    expect(res.data.data).toMatchObject({ type: 'ONE_DAY', shiftCount: 1 });
    const abs = await q<{ substitute_worker_id: string | null; substitute_application_id: string | null }>(`SELECT substitute_worker_id, substitute_application_id FROM patient_itinerary_absence WHERE request_id = $1`, [res.data.data.requestId]);
    expect(abs).toEqual([{ substitute_worker_id: null, substitute_application_id: null }]);
    const list = await api.get(`${baseUrl()}?when=upcoming`, { headers: asAdmin.headers });
    const row = (list.data.data.requests as Array<{ requestId: string; entra: { kind: string; uncoveredDates: string[] } }>).find((r) => r.requestId === res.data.data.requestId);
    expect(row?.entra).toMatchObject({ kind: 'NOBODY', uncoveredDates: [from] });
  });

  it('T6xx-extra pré-visão de "Elegir quién entra": `ignoreRequestId` aceita o pedido que já existe (turno com a falta dele, candidato livre, NADA gravado); pedido inexistente → 404; id malformado → 400', async () => {
    const from = await addDays(nextMonday, 49);
    const shifts = await shiftsOf(from, from, sub);
    expect(shifts).toHaveLength(1);
    const created = await api.post(baseUrl(), { type: 'ONE_DAY', outgoingWorkerId: titular, from, reasonCategory: 'OTHER', shifts: [{ date: shifts[0].date, slotId: shifts[0].slotId, substituteWorkerId: null }] }, { headers: asAdmin.headers });
    expect(created.status).toBe(201);
    const requestId = created.data.data.requestId as string;
    const antes = await counts();

    const res = await api.post(`${baseUrl()}/preview`, { type: 'ONE_DAY', outgoingWorkerId: titular, from, candidateWorkerIds: [sub], ignoreRequestId: requestId }, { headers: asAdmin.headers });
    expect(res.status).toBe(200);
    const data = res.data.data as { shifts: Shift[]; conflicts: Array<{ workerId: string; state: string }> };
    expect(data.shifts.map((x) => x.date)).toEqual([from]);
    expect(data.conflicts).toEqual([expect.objectContaining({ workerId: sub, state: 'free' })]);
    expect(await counts()).toEqual(antes); // LEITURA

    const inexistente = await api.post(`${baseUrl()}/preview`, { type: 'ONE_DAY', outgoingWorkerId: titular, from, candidateWorkerIds: [sub], ignoreRequestId: '00000000-0000-4000-8000-000000000000' }, { headers: asAdmin.headers });
    expect(inexistente.status).toBe(404);
    const malformado = await api.post(`${baseUrl()}/preview`, { type: 'ONE_DAY', outgoingWorkerId: titular, from, candidateWorkerIds: [sub], ignoreRequestId: 'nao-e-uuid' }, { headers: asAdmin.headers });
    expect(malformado.status).toBe(400);
  });

  // ── create: as recusas, uma a uma, com a prova de "nenhuma escrita parcial" ────────────────────
  it('motivo vazio → 422 REASON_REQUIRED (e motivo inexistente → REASON_INVALID); nada gravado — controle positivo: com motivo válido grava', async () => {
    const from = await addDays(nextMonday, 35);
    const shifts = await shiftsOf(from, from, sub);
    const antes = await counts();

    const vazio = await api.post(baseUrl(), body(from, from, shifts, sub, { type: 'ONE_DAY', reasonCategory: '' }), { headers: asAdmin.headers });
    const ausente = await api.post(baseUrl(), (({ reasonCategory: _r, ...rest }) => rest)(body(from, from, shifts, sub, { type: 'ONE_DAY' })), { headers: asAdmin.headers });
    const invalido = await api.post(baseUrl(), body(from, from, shifts, sub, { type: 'ONE_DAY', reasonCategory: 'NAO_EXISTE' }), { headers: asAdmin.headers });
    expect([vazio.status, vazio.data.code]).toEqual([422, 'REASON_REQUIRED']);
    expect([ausente.status, ausente.data.code]).toEqual([422, 'REASON_REQUIRED']);
    expect([invalido.status, invalido.data.code]).toEqual([422, 'REASON_INVALID']);
    expect(await counts()).toEqual(antes);

    const ok = await api.post(baseUrl(), body(from, from, shifts, sub, { type: 'ONE_DAY' }), { headers: asAdmin.headers });
    expect(ok.status).toBe(201);
    expect(await counts()).toEqual({ headers: antes.headers + 1, absences: antes.absences + 1, logs: antes.logs + 1 });
  });

  it('período sem turno da pessoa → 422; substituto AUSENTE no corpo → 400 (P16); turnos diferentes dos da pessoa → 422 MISMATCH; data passada → 422; nada gravado', async () => {
    const from = await addDays(nextMonday, 42);
    const shifts = await shiftsOf(from, from, sub);
    const antes = await counts();

    const terca = await addDays(nextMonday, 43);
    const semTurno = await api.post(baseUrl(), { type: 'ONE_DAY', outgoingWorkerId: titular, from: terca, reasonCategory: 'OTHER', shifts: [] }, { headers: asAdmin.headers });
    expect([semTurno.status, semTurno.data.code]).toEqual([422, 'SUBSTITUTION_NO_SHIFTS_IN_PERIOD']);

    const semChave = await api.post(baseUrl(), { type: 'ONE_DAY', outgoingWorkerId: titular, from, reasonCategory: 'OTHER', shifts: [{ date: shifts[0].date, slotId: shifts[0].slotId }] }, { headers: asAdmin.headers });
    expect(semChave.status).toBe(400);

    const divergente = await api.post(baseUrl(), { type: 'ONE_DAY', outgoingWorkerId: titular, from, reasonCategory: 'OTHER', shifts: [] }, { headers: asAdmin.headers });
    expect([divergente.status, divergente.data.code]).toEqual([422, 'SUBSTITUTION_SHIFTS_MISMATCH']);

    const passada = await api.post(baseUrl(), body(await addDays(hoje, -7), await addDays(hoje, -7), shifts, sub, { type: 'ONE_DAY' }), { headers: asAdmin.headers });
    expect([passada.status, passada.data.code]).toEqual([422, 'ABSENCE_DATE_IN_PAST']);

    expect(await counts()).toEqual(antes);
  });

  it('substituto fora do pool do serviço → 422 NOT_SELECTED_FOR_SERVICE, nada gravado', async () => {
    const from = await addDays(nextMonday, 42);
    const shifts = await shiftsOf(from, from, sub);
    const estranho = (await q<{ id: string }>(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`, [`${PREFIX}estranho`, `${PREFIX}estranho@e2e.local`]))[0].id;
    const antes = await counts();
    const res = await api.post(baseUrl(), body(from, from, shifts, estranho, { type: 'ONE_DAY' }), { headers: asAdmin.headers });
    expect([res.status, res.data.code]).toEqual([422, 'NOT_SELECTED_FOR_SERVICE']);
    expect(await counts()).toEqual(antes);
  });

  it('US5 aceite 4: 23P01 no 3º turno → 409 e NENHUMA linha gravada (cabeçalho incluso); sem o conflito, o mesmo pedido grava os 6', async () => {
    // sub2 trabalha, no OUTRO serviço do mesmo paciente, na sexta 08:00-12:00 (a mesma faixa): a sexta colide, seg e qua não.
    const extra = await mkExtraService('conflito');
    await pool.query(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'import')`, [sub2, extra.job]);
    const sextaExtra = await mkSlot(extra.sid, SEX, '08:00', 240);
    await allocate(extra.sid, sextaExtra, sub2);

    const from = await addDays(nextMonday, 56);
    const to = await addDays(from, 11);
    const shifts = await shiftsOf(from, to, sub2);
    expect(shifts).toHaveLength(6);

    // a pré-visão já avisa: as sextas (3º e 6º turnos) estão em conflito, o resto livre
    const prev = await api.post(`${baseUrl()}/preview`, { type: 'DAYS', outgoingWorkerId: titular, from, to, candidateWorkerIds: [sub2] }, { headers: asAdmin.headers });
    const states = (prev.data.data.conflicts as Array<{ slotId: string; state: string }>).map((c) => [c.slotId === slotIds[SEX], c.state]);
    expect(states.filter(([sexta]) => sexta).every(([, s]) => s === 'conflict')).toBe(true);
    expect(states.filter(([sexta]) => !sexta).every(([, s]) => s === 'free')).toBe(true);

    const antes = await counts();
    const res = await api.post(baseUrl(), body(from, to, shifts, sub2), { headers: asAdmin.headers });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('ITINERARY_OVERLAP');
    expect(await counts()).toEqual(antes); // 0 linhas: nem cabeçalho, nem as 2 ausências que passaram antes do 3º turno

    // controle positivo: o MESMO pedido com substituto sem conflito grava os 6
    const ok = await api.post(baseUrl(), body(from, to, shifts, sub), { headers: asAdmin.headers });
    expect(ok.status).toBe(201);
    expect(await counts()).toEqual({ headers: antes.headers + 1, absences: antes.absences + 6, logs: antes.logs + 6 });
  });

  it('turno que já tem falta aberta → 409 ABSENCE_ALREADY_EXISTS e nada novo gravado', async () => {
    const to = await addDays(nextMonday, 11); // o período do pedido feliz: as 6 faltas já existem
    const shifts = await shiftsOf(nextMonday, to, sub);
    const antes = await counts();
    const res = await api.post(baseUrl(), body(nextMonday, to, shifts, null), { headers: asAdmin.headers }); // "Nadie todavía": só o uq_piab_open decide
    expect([res.status, res.data.code]).toEqual([409, 'ABSENCE_ALREADY_EXISTS']);
    expect(await counts()).toEqual(antes);
  });

  it('serviço de outro paciente / inexistente → 404; id malformado → 400', async () => {
    const outro = '00000000-0000-4000-8000-000000000000';
    expect((await api.get(`${baseUrl(outro)}?when=upcoming`, { headers: asAdmin.headers })).status).toBe(404);
    expect((await api.get(`${baseUrl(outro)}/outgoing-options`, { headers: asAdmin.headers })).status).toBe(404);
    expect((await api.get(`${baseUrl('nao-e-uuid')}`, { headers: asAdmin.headers })).status).toBe(400);
  });
});

describe('069 · "No vuelve más", desfazer e "Elegir quién entra" — API real @integration', () => {
  const api = createApiClient();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const TAG = `ps069x-${RUN}-`;
  let asAdmin: { headers: { Authorization: string } };
  let hoje = '';
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`ps069x-admin-${RUN}`, 'admin');
    hoje = await hojeAr(pool);
  });
  afterAll(async () => {
    await limparB2(pool, TAG); // fecha o pool
  });

  const nextTag = (): string => `${TAG}${(seq += 1)}`;
  const h = () => ({ headers: asAdmin.headers });
  const base = (s: SeedB2): string => `/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/substitution-requests`;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
  /** A 2ª segunda estritamente depois de hoje: antes dela cabe a 1ª segunda (D-7), e D fica a mais de 7 dias de hoje. */
  const diaD = async (): Promise<string> => somaDias(pool, await proximoDia(pool, hoje, 1), 7);

  const permanent = (workerId: string, from: string, substituteWorkerId: string | null, extra: Record<string, unknown> = {}) => ({
    type: 'PERMANENT', outgoingWorkerId: workerId, from, reasonCategory: 'OTHER', substituteWorkerId, ...extra,
  });

  async function allocate(s: SeedB2, slotId: string, workerId: string): Promise<string> {
    const res = await api.post(`/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/slots/${slotId}/allocations`, { workerId }, h());
    expect(res.status).toBe(201);
    return res.data.data.allocationId as string;
  }

  /** Falta (por dias) pela API real: a pré-visão deriva os turnos, o create grava; `substitute` por turno (null = Nadie todavía). */
  async function daysRequest(s: SeedB2, workerId: string, from: string, to: string, substitute: string | null): Promise<string> {
    const prev = await api.post(`${base(s)}/preview`, { type: 'DAYS', outgoingWorkerId: workerId, from, to, candidateWorkerIds: [] }, h());
    expect(prev.status).toBe(200);
    const shifts = prev.data.data.shifts as Array<{ date: string; slotId: string }>;
    const res = await api.post(base(s), { type: 'DAYS', outgoingWorkerId: workerId, from, to, reasonCategory: 'OTHER', shifts: shifts.map((x) => ({ date: x.date, slotId: x.slotId, substituteWorkerId: substitute })) }, h());
    expect(res.status).toBe(201);
    return res.data.data.requestId as string;
  }

  const allocsOf = (s: SeedB2, workerId: string) =>
    q<{ id: string; slot_id: string; status: string; valid_from: string; valid_to: string | null }>(
      `SELECT a.id, a.slot_id, a.status, to_char(a.valid_from,'YYYY-MM-DD') AS valid_from, to_char(a.valid_to,'YYYY-MM-DD') AS valid_to
         FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id
        WHERE sl.contracted_service_id = $1 AND a.worker_id = $2 ORDER BY sl.weekday, a.valid_from`,
      [s.serviceId, workerId],
    );
  const logsOf = (requestId: string) =>
    q<{ kind: string; assignment_id: string | null; new_assignment_id: string | null; effective_date: string; destination: string | null; incoming_worker_id: string | null }>(
      `SELECT kind, assignment_id, new_assignment_id, to_char(effective_date,'YYYY-MM-DD') AS effective_date, destination, incoming_worker_id
         FROM patient_itinerary_change_log WHERE request_id = $1 ORDER BY kind, effective_date, assignment_id`,
      [requestId],
    );
  const headerOf = async (requestId: string) =>
    (await q<{ undone_at: string | null }>(`SELECT undone_at FROM patient_itinerary_substitution_request WHERE id = $1`, [requestId]))[0];
  const absenceOf = async (id: string) =>
    (await q<{ cancelled_at: string | null; substitute_worker_id: string | null }>(`SELECT cancelled_at, substitute_worker_id FROM patient_itinerary_absence WHERE id = $1`, [id]))[0];
  const counts = async (s: SeedB2) =>
    (
      await q<{ headers: number; logs: number; allocs: string }>(
        `SELECT (SELECT count(*) FROM patient_itinerary_substitution_request WHERE contracted_service_id = $1)::int AS headers,
                (SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = $1)::int AS logs,
                (SELECT string_agg(a.status || ':' || a.valid_from::text || ':' || coalesce(a.valid_to::text, 'NULL'), ',' ORDER BY a.id::text)
                   FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id WHERE sl.contracted_service_id = $1) AS allocs`,
        [s.serviceId],
      )
    )[0];
  const listRow = async (s: SeedB2, requestId: string, when: 'upcoming' | 'past' = 'upcoming') => {
    const res = await api.get(`${base(s)}?when=${when}`, h());
    expect(res.status).toBe(200);
    return (res.data.data.requests as Array<{ requestId: string; type: string; from: string; to: string | null; shiftCount: number; undoable: boolean; undoneAt: string | null; entra: { kind: string; workerIds: string[] } }>).find((r) => r.requestId === requestId);
  };

  it('T309 sem substituto (FR-30), D > hoje: 2 faixas → 2 REMOVE com o MESMO request_id e valid_to = D-1; faltas dela de D em diante canceladas (as anteriores ficam); Sin cubrir a partir de D; desfazer antes de D reabre tudo', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, desdeDias: -7 });
    const T = s.segWorkers[0];
    await allocate(s, s.slotQuaId as string, T); // T em 2 faixas (seg + qua)
    const D = await diaD();
    const Dm1 = await somaDias(pool, D, -1);
    const antesD = await somaDias(pool, D, -7); // uma segunda ANTES de D
    await daysRequest(s, T, antesD, antesD, null);
    await daysRequest(s, T, D, D, null);
    const faltas = await q<{ id: string; on_date: string }>(
      `SELECT ab.id, to_char(ab.on_date,'YYYY-MM-DD') AS on_date FROM patient_itinerary_absence ab JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
         JOIN patient_itinerary_slot sl ON sl.id = a.slot_id WHERE sl.contracted_service_id = $1 ORDER BY ab.on_date`, [s.serviceId]);
    expect(faltas.map((f) => f.on_date)).toEqual([antesD, D]); // controle positivo: as 2 faltas existem
    const antes = await counts(s);

    // P6: LEAVE_SERVICE com D > hoje é recusado SEM escrever; controle positivo logo abaixo
    const leave = await api.post(base(s), permanent(T, D, null, { destination: 'LEAVE_SERVICE' }), h());
    expect([leave.status, leave.data.code]).toEqual([422, 'DESTINATION_NOT_AVAILABLE_FOR_SCHEDULED']);
    expect(await counts(s)).toEqual(antes);

    const prev = await api.post(`${base(s)}/preview`, { type: 'PERMANENT', outgoingWorkerId: T, from: D, candidateWorkerIds: [] }, h());
    expect(prev.status).toBe(200);
    expect(prev.data.data.permanent).toEqual({ allocationCount: 2, cancelledAbsences: 1, clearedSubstitutes: 0, pendingEntry: false, scheduledExit: null });
    expect(await counts(s)).toEqual(antes); // a pré-visão é LEITURA

    const res = await api.post(base(s), permanent(T, D, null), h());
    expect(res.status).toBe(201);
    const requestId = res.data.data.requestId as string;
    expect(res.data.data).toMatchObject({ type: 'PERMANENT', from: D, to: null, shiftCount: 2, destination: 'RESERVE', cancelledAbsences: 1, clearedSubstitutes: 0 });

    const alocs = await allocsOf(s, T);
    expect(alocs).toHaveLength(2);
    expect(alocs.every((a) => a.status === 'ACTIVE' && a.valid_to === Dm1)).toBe(true); // fim agendado em D-1, o titular trabalha até lá
    const logs = await logsOf(requestId);
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.kind === 'REMOVE' && l.effective_date === Dm1 && l.destination === 'RESERVE')).toBe(true);
    expect((await absenceOf(faltas[1].id)).cancelled_at).not.toBeNull(); // FR-23: a de D foi cancelada
    expect((await absenceOf(faltas[0].id)).cancelled_at).toBeNull(); // a anterior a D fica

    const row = await listRow(s, requestId);
    expect(row).toMatchObject({ type: 'PERMANENT', from: D, to: null, shiftCount: 2, undoable: true, undoneAt: null });
    expect(row?.entra.kind).toBe('NOBODY');
    // a agenda: a partir de D a segunda está "Sin cubrir" (faixa sem ninguém), antes de D o titular segue
    const events = await api.get(`/api/admin/patients/${s.patientId}/itinerary/events?from=${D}&to=${D}&serviceId=${s.serviceId}`, h());
    const naD = (events.data.data.events as Array<{ date: string; status: string; assignmentId: string | null }>).filter((e) => e.date === D);
    expect(naD.some((e) => e.status === 'uncovered' && e.assignmentId === null)).toBe(true);

    // desfazer ANTES de D: as 2 alocações reabertas; a falta cancelada NÃO volta; o pedido fica desfeito
    const undo = await api.post(`${base(s)}/${requestId}/undo`, {}, h());
    expect(undo.status).toBe(200);
    expect(undo.data.data).toMatchObject({ requestId, type: 'PERMANENT', cancelledEntries: 0, restoredTitulars: 2 });
    expect((await allocsOf(s, T)).every((a) => a.status === 'ACTIVE' && a.valid_to === null)).toBe(true);
    expect((await absenceOf(faltas[1].id)).cancelled_at).not.toBeNull();
    expect((await headerOf(requestId)).undone_at).not.toBeNull();
    expect((await listRow(s, requestId))).toMatchObject({ undoable: false });
    const de = await api.post(`${base(s)}/${requestId}/undo`, {}, h());
    expect([de.status, de.data.code]).toEqual([409, 'REQUEST_ALREADY_UNDONE']);
  });

  it('T309 com substituto + FR-23 (substituta em falta alheia): REPLACE ligado ao request_id; o substituto dela é limpo; DESFAZER cancela a ENTRADA antes de soltar o fim (Trava A)', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, titularesQua: 1, selecionados: 1, desdeDias: -7 });
    const T = s.segWorkers[0];
    const O = s.quaWorkers[0];
    const S = s.selecionados[0];
    const D = await diaD();
    const quartaDeD = await somaDias(pool, D, 2);
    const faltaAlheia = await daysRequest(s, O, quartaDeD, quartaDeD, T); // T cobre a falta de O na quarta depois de D
    const faltaId = (await q<{ id: string }>(`SELECT id FROM patient_itinerary_absence WHERE request_id = $1`, [faltaAlheia]))[0].id;
    expect((await absenceOf(faltaId)).substitute_worker_id).toBe(T); // controle positivo

    const prev = await api.post(`${base(s)}/preview`, { type: 'PERMANENT', outgoingWorkerId: T, from: D, candidateWorkerIds: [S] }, h());
    expect(prev.status).toBe(200);
    expect(prev.data.data.conflicts).toEqual([expect.objectContaining({ workerId: S, state: 'free' })]);
    expect(prev.data.data.permanent).toEqual({ allocationCount: 1, cancelledAbsences: 0, clearedSubstitutes: 1, pendingEntry: false, scheduledExit: null });

    const res = await api.post(base(s), permanent(T, D, S), h());
    expect(res.status).toBe(201);
    const requestId = res.data.data.requestId as string;
    expect(res.data.data).toMatchObject({ shiftCount: 1, clearedSubstitutes: 1, cancelledAbsences: 0 });

    const [tSeg] = await allocsOf(s, T);
    expect(tSeg).toMatchObject({ status: 'ACTIVE', valid_to: await somaDias(pool, D, -1) });
    const [sSeg] = await allocsOf(s, S);
    expect(sSeg).toMatchObject({ slot_id: s.slotSegId, status: 'ACTIVE', valid_from: D, valid_to: null });
    const logs = await logsOf(requestId);
    expect(logs.map((l) => l.kind)).toEqual(['REPLACE', 'SUBSTITUTE_CANCELLED']);
    expect(logs[0]).toMatchObject({ assignment_id: tSeg.id, new_assignment_id: sSeg.id, incoming_worker_id: S, effective_date: D, destination: 'RESERVE' });
    expect((await absenceOf(faltaId)).substitute_worker_id).toBeNull(); // a falta de O voltou a "Sin cubrir"
    expect(await listRow(s, requestId)).toMatchObject({ type: 'PERMANENT', shiftCount: 1, undoable: true });
    expect((await listRow(s, requestId))?.entra).toMatchObject({ kind: 'PERSON', workerIds: [S] });

    const undo = await api.post(`${base(s)}/${requestId}/undo`, {}, h());
    expect(undo.status).toBe(200); // se a ORDEM fosse invertida a Trava A recusaria (409) aqui
    expect(undo.data.data).toMatchObject({ cancelledEntries: 1, restoredTitulars: 1 });
    expect((await allocsOf(s, T))[0]).toMatchObject({ status: 'ACTIVE', valid_to: null });
    expect((await allocsOf(s, S))[0]).toMatchObject({ status: 'CANCELLED' });
    expect((await absenceOf(faltaId)).substitute_worker_id).toBeNull(); // o substituto limpo NÃO volta
  });

  it('T309 D = hoje: destino OBRIGATÓRIO (422, nada gravado); a saída vale já (valid_to = ontem); pedido que já começou NÃO se desfaz (409 REQUEST_NOT_UNDOABLE)', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, desdeDias: -7 });
    const T = s.segWorkers[0];
    const prev = await api.post(`${base(s)}/preview`, { type: 'PERMANENT', outgoingWorkerId: T, from: hoje, candidateWorkerIds: [] }, h());
    expect(prev.status).toBe(200);
    expect(prev.data.data.statusAfter).toMatchObject({ current: 'ACTIVE', after: 'SEARCHING', changes: true }); // zero horas cobertas → búsqueda
    const antes = await counts(s);

    const semDestino = await api.post(base(s), permanent(T, hoje, null), h());
    expect([semDestino.status, semDestino.data.code]).toEqual([422, 'DESTINATION_REQUIRED']);
    expect(await counts(s)).toEqual(antes);

    const ok = await api.post(base(s), permanent(T, hoje, null, { destination: 'RESERVE' }), h());
    expect(ok.status).toBe(201);
    expect((await allocsOf(s, T))[0]).toMatchObject({ status: 'ACTIVE', valid_to: await somaDias(pool, hoje, -1) });
    const undo = await api.post(`${base(s)}/${ok.data.data.requestId}/undo`, {}, h());
    expect([undo.status, undo.data.code]).toEqual([409, 'REQUEST_NOT_UNDOABLE']);
    expect((await allocsOf(s, T))[0].valid_to).toBe(await somaDias(pool, hoje, -1)); // nada mudou
  });

  it('T303 P5: quem tem ENTRADA FUTURA no serviço → 409 WORKER_HAS_PENDING_ENTRY, nada gravado; controle positivo: outro titular sem entrada sai (201)', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, titularesQua: 1, selecionados: 1, desdeDias: -7 });
    const [T, U, S] = [s.segWorkers[0], s.quaWorkers[0], s.selecionados[0]];
    const D = await diaD();
    const rep = await api.post(`/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/allocations/${s.segAllocations[0]}/replace`, { newWorkerId: S, fromDate: D, reasonCategory: 'OTHER', destination: 'RESERVE' }, h());
    expect(rep.status).toBe(200); // S agora tem uma entrada futura (começa em D > hoje)
    const antes = await counts(s);

    const bloqueado = await api.post(base(s), permanent(S, await somaDias(pool, D, 7), null), h());
    expect([bloqueado.status, bloqueado.data.code]).toEqual([409, 'WORKER_HAS_PENDING_ENTRY']);
    expect(await counts(s)).toEqual(antes);
    const prev = await api.post(`${base(s)}/preview`, { type: 'PERMANENT', outgoingWorkerId: S, from: await somaDias(pool, D, 7), candidateWorkerIds: [] }, h());
    expect(prev.data.data.permanent.pendingEntry).toBe(true);

    const livre = await api.post(base(s), permanent(U, D, null), h());
    expect(livre.status).toBe(201);
    expect(T).toBeTruthy();
  });

  it('T305 "Elegir quién entra": permanente sem ninguém → aloca a pessoa na faixa a partir de D com REPLACE ligado; dias → substituto nas ausências sem ninguém; 2ª chamada = NOTHING_TO_COVER; fora do pool = 422', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, titularesQua: 1, selecionados: 1, desdeDias: -7 });
    const [T, O, S] = [s.segWorkers[0], s.quaWorkers[0], s.selecionados[0]];
    const D = await diaD();
    const estranho = (await q<{ id: string }>(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`, [`${TAG}estranho-${seq}`, `${TAG}estranho-${seq}@e2e.local`]))[0].id;

    // permanente
    const perm = await api.post(base(s), permanent(T, D, null), h());
    expect(perm.status).toBe(201);
    const pid = perm.data.data.requestId as string;
    const fora = await api.post(`${base(s)}/${pid}/cover`, { substituteWorkerId: estranho }, h());
    expect([fora.status, fora.data.code]).toEqual([422, 'NOT_SELECTED_FOR_SERVICE']);
    expect(await allocsOf(s, estranho)).toEqual([]);
    const cover = await api.post(`${base(s)}/${pid}/cover`, { substituteWorkerId: S }, h());
    expect(cover.status).toBe(200);
    expect(cover.data.data).toMatchObject({ type: 'PERMANENT', covered: 1 });
    const [tSeg] = await allocsOf(s, T);
    const [sSeg] = await allocsOf(s, S);
    expect(sSeg).toMatchObject({ slot_id: s.slotSegId, status: 'ACTIVE', valid_from: D, valid_to: null });
    const replace = (await logsOf(pid)).find((l) => l.kind === 'REPLACE');
    expect(replace).toMatchObject({ assignment_id: tSeg.id, new_assignment_id: sSeg.id, incoming_worker_id: S, effective_date: D, destination: 'RESERVE' });
    expect((await listRow(s, pid))?.entra).toMatchObject({ kind: 'PERSON', workerIds: [S] });
    const de = await api.post(`${base(s)}/${pid}/cover`, { substituteWorkerId: S }, h());
    expect([de.status, de.data.code]).toEqual([409, 'NOTHING_TO_COVER']);

    // dias
    const quarta = await somaDias(pool, D, 2);
    const did = await daysRequest(s, O, quarta, quarta, null);
    const faltaId = (await q<{ id: string }>(`SELECT id FROM patient_itinerary_absence WHERE request_id = $1`, [did]))[0].id;
    const foraDias = await api.post(`${base(s)}/${did}/cover`, { substituteWorkerId: estranho }, h());
    expect([foraDias.status, foraDias.data.code]).toEqual([422, 'NOT_SELECTED_FOR_SERVICE']);
    expect((await absenceOf(faltaId)).substitute_worker_id).toBeNull();
    const coverDias = await api.post(`${base(s)}/${did}/cover`, { substituteWorkerId: T }, h()); // T (pool) cobre a quarta de O; T trabalha só até D-1 na segunda, sem choque
    expect(coverDias.status).toBe(200);
    expect(coverDias.data.data).toMatchObject({ type: 'ONE_DAY', covered: 1 });
    expect((await absenceOf(faltaId)).substitute_worker_id).toBe(T);
    expect((await api.post(`${base(s)}/${did}/cover`, { substituteWorkerId: T }, h())).data.code).toBe('NOTHING_TO_COVER');

    // desfazer o permanente depois do cover: a entrada some e o titular volta
    const undo = await api.post(`${base(s)}/${pid}/undo`, {}, h());
    expect(undo.status).toBe(200);
    expect((await allocsOf(s, S))[0].status).toBe('CANCELLED');
    expect((await allocsOf(s, T))[0]).toMatchObject({ status: 'ACTIVE', valid_to: null });
    // cover num pedido desfeito e num pedido inexistente
    expect((await api.post(`${base(s)}/${pid}/cover`, { substituteWorkerId: S }, h())).data.code).toBe('REQUEST_ALREADY_UNDONE');
    expect((await api.post(`${base(s)}/00000000-0000-4000-8000-000000000000/cover`, { substituteWorkerId: S }, h())).status).toBe(404);
  });

  it('T304/T308 desfazer por DIAS: cancela só as ausências de hoje em diante (a passada fica); pedido todo passado = 409 REQUEST_NOT_UNDOABLE; faixa com pedido futuro recusa editar/encerrar e nenhuma ausência muda (P1)', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, desdeDias: -7 });
    const T = s.segWorkers[0];
    const D = await diaD();
    const D2 = await somaDias(pool, D, 7);
    const rid = await daysRequest(s, T, D, D2, null); // 2 segundas futuras
    const passada = (await q<{ d: string }>(
      `SELECT to_char(g::date, 'YYYY-MM-DD') AS d FROM generate_series($1::date - 7, $1::date - 1, interval '1 day') g WHERE extract(dow FROM g) = 1`, [hoje]))[0].d;
    const alocacao = (await allocsOf(s, T))[0];
    await pool.query(
      `INSERT INTO patient_itinerary_absence (assignment_id, on_date, created_by, updated_by, request_id) VALUES ($1, $2::date, 'e2e', 'e2e', $3)`,
      [alocacao.id, passada, rid],
    ); // a falta PASSADA do mesmo pedido (semente SQL, DX-13.15)
    const abs = await q<{ id: string; on_date: string }>(`SELECT id, to_char(on_date,'YYYY-MM-DD') AS on_date FROM patient_itinerary_absence WHERE request_id = $1 ORDER BY on_date`, [rid]);
    expect(abs.map((a) => a.on_date)).toEqual([passada, D, D2]);

    // T308 (P1): com pedido futuro a faixa não se edita nem se encerra — recusa e nenhuma ausência muda
    const snap = async () => (await q<{ n: number; c: number }>(`SELECT count(*)::int AS n, count(cancelled_at)::int AS c FROM patient_itinerary_absence WHERE request_id = $1`, [rid]))[0];
    const antesSlot = await snap();
    const edita = await api.patch(`/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/slots/${s.slotSegId}`, { weekday: 2, startTime: '08:00', durationMinutes: 240 }, h());
    expect([edita.status, edita.data.code]).toEqual([422, 'SLOT_HAS_ACTIVE_ALLOCATION']);
    const encerra = await api.post(`/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/slots/${s.slotSegId}/end`, {}, h());
    expect([encerra.status, encerra.data.code]).toEqual([422, 'SLOT_HAS_ACTIVE_ALLOCATION']);
    expect(await snap()).toEqual(antesSlot);

    const undo = await api.post(`${base(s)}/${rid}/undo`, {}, h());
    expect(undo.status).toBe(200);
    expect(undo.data.data).toMatchObject({ type: 'DAYS', cancelledAbsences: 2 });
    expect((await absenceOf(abs[0].id)).cancelled_at).toBeNull(); // o dia passado fica (US7)
    expect((await absenceOf(abs[1].id)).cancelled_at).not.toBeNull();
    expect((await absenceOf(abs[2].id)).cancelled_at).not.toBeNull();
    expect((await headerOf(rid)).undone_at).not.toBeNull();

    // pedido todo passado: sem nada futuro a desfazer (outra semente: a única segunda passada da janela já está ocupada acima)
    const s2 = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, desdeDias: -7 });
    const alocacao2 = (await allocsOf(s2, s2.segWorkers[0]))[0];
    const pastReq = await seedRequestForAssignment(pool, alocacao2.id, { createdBy: 'e2e' });
    await pool.query(
      `INSERT INTO patient_itinerary_absence (assignment_id, on_date, created_by, updated_by, request_id) VALUES ($1, $2::date, 'e2e', 'e2e', $3)`,
      [alocacao2.id, passada, pastReq],
    );
    const viva = await q<{ id: string }>(`SELECT id FROM patient_itinerary_absence WHERE request_id = $1`, [pastReq]);
    expect(viva).toHaveLength(1); // controle positivo: a falta passada do pedido existe
    const passadoTodo = await api.post(`${base(s2)}/${pastReq}/undo`, {}, h());
    expect([passadoTodo.status, passadoTodo.data.code]).toEqual([409, 'REQUEST_NOT_UNDOABLE']);
    expect((await absenceOf(viva[0].id)).cancelled_at).toBeNull();
    expect((await headerOf(pastReq)).undone_at).toBeNull();
  });
});
