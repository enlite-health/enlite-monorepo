/**
 * 058b-replace-destino.e2e.test.ts @integration — 058b/B2 (T242): `POST .../itinerary/allocations/:id/replace` com
 * motivo e destino (Caso A: o titular começou hoje/antes e o reemplazo é de hoje; Caso B: reemplazo agendado).
 * Passa SEMPRE pela API HTTP real (`staffAuth`); a semente é SQL como dono (`seedB2`). A API roda como dono do banco
 * no stack E2E (bypassa RLS): estes casos provam o FLUXO, não a RLS.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { seedB2, hojeAr, somaDias, limparB2 } from './helpers/seedItinerarioB2';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `058b-repl-${RUN}-`;
const REASON = 'DESISTENCIA_DO_PRESTADOR';

describe('POST …/allocations/:id/replace — Caso A/B (058) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  let hoje = '';
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`058b-repl-admin-${RUN}`, 'admin');
    hoje = await hojeAr(pool);
  });

  afterAll(async () => {
    await limparB2(pool, TASK_PREFIX);
  });

  const nextTag = (): string => {
    seq += 1;
    return `${TASK_PREFIX}${seq}`;
  };

  const replaceUrl = (s: { patientId: string; serviceId: string }, allocationId: string): string =>
    `/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/allocations/${allocationId}/replace`;

  async function alloc(id: string) {
    const r = await pool.query<{ status: string; vf: string; vt: string | null }>(
      `SELECT status, to_char(valid_from,'YYYY-MM-DD') AS vf, to_char(valid_to,'YYYY-MM-DD') AS vt
         FROM patient_itinerary_assignment WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  async function allocationOf(serviceId: string, workerId: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `SELECT a.id FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id
        WHERE sl.contracted_service_id = $1 AND a.worker_id = $2 AND a.status <> 'CANCELLED'`,
      [serviceId, workerId],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0].id;
  }

  /** Contagens por serviço: alocações por status, registro de trocas e marcas — para provar "0 escritas". */
  async function snapshot(serviceId: string) {
    const r = await pool.query(
      `SELECT (SELECT coalesce(json_agg(x ORDER BY x), '[]'::json) FROM (
                 SELECT a.status || ':' || a.worker_id::text || ':' || a.valid_from::text || ':' || coalesce(a.valid_to::text, 'NULL') AS x
                   FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id
                  WHERE sl.contracted_service_id = $1) t) AS alocacoes,
              (SELECT count(*)::int FROM patient_itinerary_change_log WHERE contracted_service_id = $1) AS registros,
              (SELECT count(*)::int FROM contracted_service_rejections WHERE service_id = $1) AS marcas`,
      [serviceId],
    );
    return r.rows[0];
  }

  it('Caso A RESERVE: titular que começou hoje → CANCELLED; substituto ACTIVE desde hoje; 1 log REPLACE; nenhuma marca', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, selecionados: 1 });
    const res = await api.post(
      replaceUrl(s, s.segAllocations[0]),
      { newWorkerId: s.selecionados[0], fromDate: hoje, reasonCategory: REASON, destination: 'RESERVE' },
      { headers: asAdmin.headers },
    );
    expect(res.status).toBe(200);
    expect(res.data.data.destination).toBe('RESERVE');

    expect(await alloc(s.segAllocations[0])).toMatchObject({ status: 'CANCELLED' });
    const novaId = await allocationOf(s.serviceId, s.selecionados[0]);
    expect(await alloc(novaId)).toEqual({ status: 'ACTIVE', vf: hoje, vt: null });

    const log = await pool.query(
      `SELECT kind, destination, reason_code, outgoing_worker_id, incoming_worker_id, assignment_id, new_assignment_id,
              to_char(effective_date,'YYYY-MM-DD') AS d
         FROM patient_itinerary_change_log WHERE contracted_service_id = $1`,
      [s.serviceId],
    );
    expect(log.rows).toEqual([
      {
        kind: 'REPLACE', destination: 'RESERVE', reason_code: REASON, outgoing_worker_id: s.segWorkers[0],
        incoming_worker_id: s.selecionados[0], assignment_id: s.segAllocations[0], new_assignment_id: novaId, d: hoje,
      },
    ]);
    const marcas = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM contracted_service_rejections WHERE service_id = $1`, [s.serviceId]);
    expect(marcas.rows[0].n).toBe(0);
  });

  it('Caso A LEAVE_SERVICE: titular antigo fica ACTIVE até ontem; marca de rejeição com o MESMO código; log REPLACE/LEAVE_SERVICE', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, selecionados: 1, desdeDias: -7 });
    const ontem = await somaDias(pool, hoje, -1);
    const res = await api.post(
      replaceUrl(s, s.segAllocations[0]),
      { newWorkerId: s.selecionados[0], fromDate: hoje, reasonCategory: REASON, destination: 'LEAVE_SERVICE' },
      { headers: asAdmin.headers },
    );
    expect(res.status).toBe(200);

    expect(await alloc(s.segAllocations[0])).toMatchObject({ status: 'ACTIVE', vt: ontem });
    const novaId = await allocationOf(s.serviceId, s.selecionados[0]);
    expect(await alloc(novaId)).toEqual({ status: 'ACTIVE', vf: hoje, vt: null });

    const marks = await pool.query(
      `SELECT worker_id, reject_reason_category FROM contracted_service_rejections WHERE service_id = $1 AND reverted_at IS NULL`,
      [s.serviceId],
    );
    expect(marks.rows).toEqual([{ worker_id: s.segWorkers[0], reject_reason_category: REASON }]);
    const log = await pool.query(
      `SELECT kind, destination FROM patient_itinerary_change_log WHERE contracted_service_id = $1`,
      [s.serviceId],
    );
    expect(log.rows).toEqual([{ kind: 'REPLACE', destination: 'LEAVE_SERVICE' }]);
  });
});
