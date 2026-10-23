/**
 * 069-pedido-substituicao.e2e.test.ts @integration — spec 069, F2 (parte DIAS).
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
