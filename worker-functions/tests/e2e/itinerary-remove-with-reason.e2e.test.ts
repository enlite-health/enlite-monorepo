/**
 * itinerary-remove-with-reason.e2e.test.ts @integration — change itinerario-trocas-motivos-e-figma, Fase 4.
 *
 * Prova, contra a API REAL de pé + Postgres real, `POST .../itinerary/allocations/:allocationId/end` com corpo
 * `{ reasonCategory, destination }` (tirar do itinerário com motivo e destino, D4-C6). A chamada passa SEMPRE pela
 * API HTTP (`staffAuth`); a semente (paciente, serviço, faixa, prestador, alocação vigente, montado) é SQL como dono —
 * a regra de capacidade da faixa é da Fase 5, então duas titulares na mesma faixa só existem semeadas por SQL.
 *
 *   (1) única titular, itinerário montado → tirar (RESERVE) → paciente SEARCHING, 1 linha REMOVE, nenhuma marca.
 *   (2) faixa com 2 titulares → tirar 1 → REPLACEMENT (a outra continua cobrindo).
 *   (3) LEAVE_SERVICE → marca em contracted_service_rejections com o MESMO código do motivo.
 *   (4) sem motivo → 422 REASON_REQUIRED (e sem destino → 422 DESTINATION_REQUIRED) e 0 escritas: a contagem por id
 *       (alocação, registro, marca, status) ANTES é igual à de DEPOIS.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `irwr-e2e-${RUN}-`;
const REASON = 'DESISTENCIA_DO_PRESTADOR';
const SCHEDULE_ONE = JSON.stringify([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }]);
const SCHEDULE_TWO = JSON.stringify([
  { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
  { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
]);

interface Seeded {
  patientId: string;
  serviceId: string;
  workerIds: string[];
  allocationIds: string[];
}

describe('POST .../allocations/:id/end com motivo e destino — API real (Fase 4, C6) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let hoje = '';
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`irwr-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const d = await pool.query<{ hoje: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS hoje`,
    );
    hoje = d.rows[0].hoje;
  });

  afterAll(async () => {
    try {
      const pats = `SELECT id FROM patients WHERE clickup_task_id LIKE $1`;
      const svcs = `SELECT id FROM patient_contracted_services WHERE patient_id IN (${pats})`;
      const like = [`${TASK_PREFIX}%`];
      // O registro de trocas (494) é append-only para a app e sem cascata: o dono do banco o apaga ANTES.
      await pool.query(`DELETE FROM patient_itinerary_change_log WHERE contracted_service_id IN (${svcs})`, like);
      await pool.query(`DELETE FROM contracted_service_rejections WHERE service_id IN (${svcs})`, like);
      await pool.query(
        `DELETE FROM patient_itinerary_assignment WHERE slot_id IN (
           SELECT s.id FROM patient_itinerary_slot s WHERE s.contracted_service_id IN (${svcs}))`,
        like,
      );
      await pool.query(`DELETE FROM patient_itinerary_assembly WHERE patient_id IN (${pats})`, like);
      await pool.query(
        `DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`,
        like,
      );
      await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, like);
      await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, like);
      await pool.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (${svcs})`, like);
      await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (${pats})`, like);
      await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (${pats})`, like);
      await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, like);
      const left = await pool.query<{ p: number; w: number; j: number }>(
        `SELECT (SELECT count(*)::int FROM patients WHERE clickup_task_id LIKE $1) AS p,
                (SELECT count(*)::int FROM workers WHERE auth_uid LIKE $1) AS w,
                (SELECT count(*)::int FROM job_postings WHERE title LIKE $1) AS j`,
        like,
      );
      expect(left.rows[0]).toEqual({ p: 0, w: 0, j: 0 });
    } finally {
      await pool.end();
    }
  });

  /**
   * Paciente AR (estado inicial `status`), serviço AT com a grade dada, vaga viva, `titulares` prestadores em
   * Selecionado (C) com alocação vigente (desde hoje) na faixa de segunda, itinerário montado.
   */
  async function seed(status: string, opts: { weeklyHours: number; schedule: string; titulares: number }): Promise<Seeded> {
    seq += 1;
    const tag = `${TASK_PREFIX}${seq}`;
    const patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, has_consent, insurance_informed)
         VALUES ($1, 'Itinerario', 'Quitar', 'AR', $2, true, 'OSDE') RETURNING id`,
        [tag, status],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country, lat, lng) VALUES ($1, 'AR', -34.6, -58.4) RETURNING id`,
        [patientId],
      )
    ).rows[0].id;
    const serviceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, weekly_hours, schedule, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, $3, $4::jsonb, 'AR', $5, $5) RETURNING id`,
        [patientId, addressId, opts.weeklyHours, opts.schedule, TASK_PREFIX],
      )
    ).rows[0].id;
    const mkSlot = async (weekday: number) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
           VALUES ($1, $2, '08:00', '12:00', $3, $3) RETURNING id`,
          [serviceId, weekday, TASK_PREFIX],
        )
      ).rows[0].id;
    const mondaySlotId = await mkSlot(1);
    if (opts.schedule === SCHEDULE_TWO) await mkSlot(3);
    const jobId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${tag}-vaga`, serviceId, patientId],
      )
    ).rows[0].id;
    const workerIds: string[] = [];
    const allocationIds: string[] = [];
    for (let i = 0; i < opts.titulares; i += 1) {
      const workerId = (
        await pool.query<{ id: string }>(
          `INSERT INTO workers (auth_uid, email, country, status, occupation) VALUES ($1, $2, 'AR', 'REGISTERED', 'AT') RETURNING id`,
          [`${tag}-w${i}`, `${tag}-w${i}@e2e.local`],
        )
      ).rows[0].id;
      const applicationId = (
        await pool.query<{ id: string }>(
          `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
           VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'manual') RETURNING id`,
          [workerId, jobId],
        )
      ).rows[0].id;
      const allocationId = (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5) RETURNING id`,
          [mondaySlotId, workerId, applicationId, hoje, TASK_PREFIX],
        )
      ).rows[0].id;
      workerIds.push(workerId);
      allocationIds.push(allocationId);
    }
    await pool.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, $2, 'AR')`, [
      patientId,
      TASK_PREFIX,
    ]);
    return { patientId, serviceId, workerIds, allocationIds };
  }

  const endUrl = (s: Seeded, allocationId: string) =>
    `/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/allocations/${allocationId}/end`;

  async function snapshot(s: Seeded, allocationId: string) {
    const r = await pool.query<{ status: string; alloc: string; vigente: number; registros: number; marcas: number }>(
      `SELECT (SELECT status FROM patients WHERE id = $1) AS status,
              (SELECT status FROM patient_itinerary_assignment WHERE id = $3) AS alloc,
              (SELECT count(*)::int FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id
                WHERE sl.contracted_service_id = $2 AND a.status = 'ACTIVE') AS vigente,
              (SELECT count(*)::int FROM patient_itinerary_change_log WHERE contracted_service_id = $2) AS registros,
              (SELECT count(*)::int FROM contracted_service_rejections WHERE service_id = $2) AS marcas`,
      [s.patientId, s.serviceId, allocationId],
    );
    return r.rows[0];
  }

  it('(1) única titular com itinerário montado → tirar (RESERVE) → SEARCHING, 1 linha REMOVE, nenhuma marca', async () => {
    const s = await seed('REPLACEMENT', { weeklyHours: 4, schedule: SCHEDULE_ONE, titulares: 1 });
    const res = await api.post(endUrl(s, s.allocationIds[0]), { reasonCategory: REASON, destination: 'RESERVE' }, { headers: asAdmin.headers });
    expect(res.status).toBe(200);
    expect(res.data.data).toMatchObject({ allocationId: s.allocationIds[0], status: 'ENDED', validTo: hoje, destination: 'RESERVE' });

    const after = await snapshot(s, s.allocationIds[0]);
    expect(after).toMatchObject({ status: 'SEARCHING', alloc: 'ENDED', vigente: 0, registros: 1, marcas: 0 });
    const log = await pool.query(
      `SELECT kind, destination, reason_code, outgoing_worker_id, assignment_id, to_char(effective_date,'YYYY-MM-DD') AS d
         FROM patient_itinerary_change_log WHERE contracted_service_id = $1`,
      [s.serviceId],
    );
    expect(log.rows).toEqual([
      { kind: 'REMOVE', destination: 'RESERVE', reason_code: REASON, outgoing_worker_id: s.workerIds[0], assignment_id: s.allocationIds[0], d: hoje },
    ]);
  });

  it('(2) faixa com 2 titulares (semeadas por SQL) → tirar 1 → REPLACEMENT; a outra segue vigente', async () => {
    const s = await seed('ACTIVE', { weeklyHours: 8, schedule: SCHEDULE_TWO, titulares: 2 });
    const res = await api.post(endUrl(s, s.allocationIds[0]), { reasonCategory: REASON, destination: 'RESERVE' }, { headers: asAdmin.headers });
    expect(res.status).toBe(200);

    const after = await snapshot(s, s.allocationIds[0]);
    expect(after).toMatchObject({ status: 'REPLACEMENT', alloc: 'ENDED', vigente: 1, registros: 1, marcas: 0 });
    const other = await pool.query(`SELECT status FROM patient_itinerary_assignment WHERE id = $1`, [s.allocationIds[1]]);
    expect(other.rows[0].status).toBe('ACTIVE');
  });

  it('(3) LEAVE_SERVICE → marca em contracted_service_rejections com o MESMO código do motivo', async () => {
    const s = await seed('REPLACEMENT', { weeklyHours: 4, schedule: SCHEDULE_ONE, titulares: 1 });
    const res = await api.post(endUrl(s, s.allocationIds[0]), { reasonCategory: REASON, destination: 'LEAVE_SERVICE' }, { headers: asAdmin.headers });
    expect(res.status).toBe(200);
    expect(res.data.data.destination).toBe('LEAVE_SERVICE');

    const marks = await pool.query(
      `SELECT worker_id, reject_reason_category, reverted_at FROM contracted_service_rejections WHERE service_id = $1`,
      [s.serviceId],
    );
    expect(marks.rows).toEqual([{ worker_id: s.workerIds[0], reject_reason_category: REASON, reverted_at: null }]);
    const log = await pool.query(`SELECT kind, destination, reason_code FROM patient_itinerary_change_log WHERE contracted_service_id = $1`, [s.serviceId]);
    expect(log.rows).toEqual([{ kind: 'REMOVE', destination: 'LEAVE_SERVICE', reason_code: REASON }]);
    expect((await snapshot(s, s.allocationIds[0])).status).toBe('SEARCHING');
  });

  it('(4) sem motivo → 422 REASON_REQUIRED; sem destino → 422 DESTINATION_REQUIRED; motivo fora do catálogo → 422 REASON_INVALID; 0 escritas (contagem por id antes = depois)', async () => {
    const s = await seed('REPLACEMENT', { weeklyHours: 4, schedule: SCHEDULE_ONE, titulares: 1 });
    const before = await snapshot(s, s.allocationIds[0]);
    expect(before).toMatchObject({ status: 'REPLACEMENT', alloc: 'ACTIVE', vigente: 1, registros: 0, marcas: 0 });

    const semMotivo = await api.post(endUrl(s, s.allocationIds[0]), { destination: 'RESERVE' }, { headers: asAdmin.headers });
    expect(semMotivo.status).toBe(422);
    expect(semMotivo.data.code).toBe('REASON_REQUIRED');

    const semCorpo = await api.post(endUrl(s, s.allocationIds[0]), undefined, { headers: asAdmin.headers });
    expect(semCorpo.status).toBe(422);
    expect(semCorpo.data.code).toBe('REASON_REQUIRED');

    const semDestino = await api.post(endUrl(s, s.allocationIds[0]), { reasonCategory: REASON }, { headers: asAdmin.headers });
    expect(semDestino.status).toBe(422);
    expect(semDestino.data.code).toBe('DESTINATION_REQUIRED');

    const motivoInvalido = await api.post(endUrl(s, s.allocationIds[0]), { reasonCategory: 'NAO_EXISTE_NO_CATALOGO', destination: 'LEAVE_SERVICE' }, { headers: asAdmin.headers });
    expect(motivoInvalido.status).toBe(422);
    expect(motivoInvalido.data.code).toBe('REASON_INVALID');

    expect(await snapshot(s, s.allocationIds[0])).toEqual(before);
  });
});
