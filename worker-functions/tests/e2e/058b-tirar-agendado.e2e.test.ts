/**
 * 058b-tirar-agendado.e2e.test.ts @integration — 058b/B2 (T244): `POST .../itinerary/allocations/:id/end` de quem tem
 * AGENDAMENTO (substituto em ausência futura de outro titular, ou entrada futura). Passa SEMPRE pela API HTTP real
 * (`staffAuth`); a semente e as ausências são SQL como dono. A API roda como dono no stack E2E (bypassa RLS): prova o FLUXO.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { seedB2, hojeAr, somaDias, proximoDia, limparB2, type SeedB2 } from './helpers/seedItinerarioB2';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `058b-tirar-${RUN}-`;

describe('POST …/allocations/:id/end com agendamento — API real (058 P5c) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  let hoje = '';
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`058b-tirar-admin-${RUN}`, 'admin');
    hoje = await hojeAr(pool);
  });

  afterAll(async () => {
    await limparB2(pool, TASK_PREFIX);
  });

  const nextTag = (): string => {
    seq += 1;
    return `${TASK_PREFIX}${seq}`;
  };
  const endUrl = (s: SeedB2, allocationId: string): string =>
    `/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/allocations/${allocationId}/end`;

  async function applicationOf(allocationId: string): Promise<string> {
    const r = await pool.query<{ application_id: string }>(`SELECT application_id FROM patient_itinerary_assignment WHERE id = $1`, [allocationId]);
    return r.rows[0].application_id;
  }

  /** C = titular na segunda; A = titular na quarta; C é SUBSTITUTO nas 2 próximas quartas de A (ausências por SQL como dono). */
  async function cenarioSubstituto(tag: string) {
    const s = await seedB2(pool, tag, { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, titularesQua: 1, desdeDias: -7 });
    const d1 = await proximoDia(pool, s.hoje, 3);
    const d2 = await somaDias(pool, d1, 7);
    const appC = await applicationOf(s.segAllocations[0]);
    for (const d of [d1, d2]) {
      await pool.query(
        `INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
         VALUES ($1, $2::date, $3, $4, 'e2e', 'e2e')`,
        [s.quaAllocations[0], d, s.segWorkers[0], appC],
      );
    }
    return { s, d1, d2 };
  }

  async function snapshot(s: SeedB2) {
    const r = await pool.query(
      `SELECT (SELECT coalesce(json_agg(x ORDER BY x), '[]'::json) FROM (
                 SELECT a.status || ':' || a.worker_id::text || ':' || a.valid_from::text || ':' || coalesce(a.valid_to::text, 'NULL') AS x
                   FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id
                  WHERE sl.contracted_service_id = $1) t) AS alocacoes,
              (SELECT count(*)::int FROM patient_itinerary_change_log WHERE contracted_service_id = $1) AS registros,
              (SELECT count(*)::int FROM contracted_service_rejections WHERE service_id = $1) AS marcas,
              (SELECT count(*)::int FROM patient_itinerary_absence ab
                 WHERE ab.substitute_worker_id IS NOT NULL AND ab.cancelled_at IS NULL
                   AND ab.assignment_id IN (SELECT a.id FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id WHERE sl.contracted_service_id = $1)) AS com_substituto`,
      [s.serviceId],
    );
    return r.rows[0];
  }

  it('LEAVE_SERVICE com agendamento e SEM cancelScheduled → 409 WORKER_HAS_SCHEDULED_ATTENDANCES com as 2 datas; snapshot antes = depois', async () => {
    const { s, d1, d2 } = await cenarioSubstituto(nextTag());
    const before = await snapshot(s);
    // Controle (contagem zero = falha): as 2 ausências com substituto existem ANTES do POST.
    expect(before).toMatchObject({ com_substituto: 2, registros: 0, marcas: 0 });

    const res = await api.post(endUrl(s, s.segAllocations[0]), { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE' }, { headers: asAdmin.headers });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('WORKER_HAS_SCHEDULED_ATTENDANCES');
    expect(res.data.details.substitutionDates).toEqual([d1, d2]);
    expect(res.data.details.futureEntryFrom).toBeNull();
    expect(await snapshot(s)).toEqual(before);
  });
});
