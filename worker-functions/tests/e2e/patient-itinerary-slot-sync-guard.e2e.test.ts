/**
 * patient-itinerary-slot-sync-guard.e2e.test.ts @integration — cadeia-paciente-vacante-itinerario, Fase 12, P5
 *
 * Prova, contra a API REAL e o Postgres real, o conserto do sync do serviço contratado (D442,
 * DX-12.15): o PATCH do serviço que tiraria do `schedule` um slot com alocação `ACTIVE` vigente
 * em `hoje` (Buenos Aires) é recusado com 422 `SLOT_HAS_ACTIVE_ALLOCATION` nomeando o slot, e a
 * transação inteira desfaz (nenhum slot muda). O serviço nasce SEMPRE pela API (o sync só roda por
 * ela); vaga, candidatura, worker e alocação entram por SQL como dono. Datas do banco
 * (DATA-F12), nunca do runner. Um paciente por `it`; limpeza em `finally` por `patient_id` e
 * varredura final por prefixo contando 0.
 *
 *   (a) alocação ACTIVE sem fim no slot de segunda → PATCH [quarta] → 422, os 2 slots seguem ativos.
 *   (b) sem alocação → 200 e o slot de segunda desativa (como antes).
 *   (c) alocação ENDED com fim ontem → 200.
 *   (d) alocação ACTIVE vencida (fim ontem) → 200.
 *   (e) `schedule: null` com alocação vigente → 422 (o caminho "desativa tudo").
 *   (f) PATCH só de `weeklyHours` com alocação vigente → 200 (sem a chave `schedule` o sync não roda).
 *   (g) a rota da Fase 11 (PATCH do slot) com o slot alocado segue 422.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pisg-e2e-${RUN}-`;

const MONDAY = { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' };
const WEDNESDAY = { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' };

interface SlotRow {
  id: string;
  weekday: number;
  active: boolean;
}

interface Seeded {
  patientId: string;
  serviceId: string;
  mondaySlotId: string;
  wednesdaySlotId: string;
}

describe('sync do serviço contratado recusa desativar slot alocado — D442 (Fase 12, P5) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let hoje = '';
  let ontem = '';
  let semanaAtras = '';
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`pisg-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    const d = await pool.query<{ hoje: string; ontem: string; semana: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS hoje,
              to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 1, 'YYYY-MM-DD') AS ontem,
              to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 7, 'YYYY-MM-DD') AS semana`,
    );
    hoje = d.rows[0].hoje;
    ontem = d.rows[0].ontem;
    semanaAtras = d.rows[0].semana;
  });

  afterAll(async () => {
    // Varredura de segurança do RUN inteiro: alocação → WJA → vaga → paciente (serviço e slots em
    // cascata) → worker; contando 0 linhas do prefixo no fim.
    try {
      await pool.query(`DELETE FROM patient_itinerary_assignment WHERE created_by = $1`, [TASK_PREFIX]);
      await pool.query(
        `DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`,
        [`${TASK_PREFIX}%`],
      );
      await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, [`${TASK_PREFIX}%`]);
      await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
      await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${TASK_PREFIX}%`]);
      const left = await pool.query<{ p: number; w: number; j: number }>(
        `SELECT (SELECT count(*)::int FROM patients WHERE clickup_task_id LIKE $1) AS p,
                (SELECT count(*)::int FROM workers WHERE auth_uid LIKE $1) AS w,
                (SELECT count(*)::int FROM job_postings WHERE title LIKE $1) AS j`,
        [`${TASK_PREFIX}%`],
      );
      console.log('[12.5] limpeza final', left.rows[0]);
      expect(left.rows[0]).toEqual({ p: 0, w: 0, j: 0 });
    } finally {
      await pool.end();
    }
  });

  async function cleanupPatient(patientId: string): Promise<void> {
    await pool.query(
      `DELETE FROM patient_itinerary_assignment WHERE slot_id IN (
         SELECT s.id FROM patient_itinerary_slot s
           JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
          WHERE pcs.patient_id = $1)`,
      [patientId],
    );
    const wja = await pool.query<{ worker_id: string }>(
      `DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id = $1)
       RETURNING worker_id`,
      [patientId],
    );
    await pool.query(`DELETE FROM job_postings WHERE patient_id = $1`, [patientId]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[]) AND auth_uid LIKE $2`, [
      wja.rows.map((r) => r.worker_id),
      `${TASK_PREFIX}%`,
    ]);
  }

  async function slotsOf(serviceId: string): Promise<SlotRow[]> {
    const r = await pool.query<SlotRow>(
      `SELECT id, weekday, active FROM patient_itinerary_slot WHERE contracted_service_id = $1 ORDER BY weekday`,
      [serviceId],
    );
    return r.rows;
  }

  /** Paciente + endereço por SQL; o serviço (segunda 08-12 + quarta 14-18) PELA API. */
  async function seedService(slug: string): Promise<Seeded> {
    seq += 1;
    const patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'Guarda', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}${seq}-${slug}`],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patientId],
      )
    ).rows[0].id;
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', weeklyHours: 8, addressId, schedule: [MONDAY, WEDNESDAY] },
      asAdmin,
    );
    expect(created.status).toBe(201);
    const serviceId = created.data.data.id as string;
    const slots = await slotsOf(serviceId);
    expect(slots.map((s) => [s.weekday, s.active])).toEqual([
      [1, true],
      [3, true],
    ]);
    return { patientId, serviceId, mondaySlotId: slots[0].id, wednesdaySlotId: slots[1].id };
  }

  /** Vaga + worker + candidatura + alocação no slot, por SQL como dono. */
  async function allocate(
    seed: Seeded,
    slotId: string,
    opts: { validFrom: string; validTo: string | null; status: 'ACTIVE' | 'ENDED' },
  ): Promise<string> {
    const jobId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${TASK_PREFIX}${seq}-vaga`, seed.serviceId, seed.patientId],
      )
    ).rows[0].id;
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}${seq}-w`, `${TASK_PREFIX}${seq}-w@e2e.local`],
      )
    ).rows[0].id;
    const wjaId = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobId],
      )
    ).rows[0].id;
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [slotId, workerId, wjaId, opts.validFrom, opts.validTo, opts.status, TASK_PREFIX],
      )
    ).rows[0].id;
  }

  function patchService(seed: Seeded, body: Record<string, unknown>) {
    return api.patch(`/api/admin/patients/${seed.patientId}/contracted-services/${seed.serviceId}`, body, asAdmin);
  }

  it('(a) alocação ACTIVE sem fim no slot de segunda → PATCH só quarta → 422 nomeando o slot, os 2 seguem ativos', async () => {
    const seed = await seedService('a');
    try {
      await allocate(seed, seed.mondaySlotId, { validFrom: semanaAtras, validTo: null, status: 'ACTIVE' });
      const r = await patchService(seed, { schedule: [WEDNESDAY] });
      console.log('[12.5] (a) status', r.status, 'code', r.data?.code, 'slotId==segunda', r.data?.details?.slotId === seed.mondaySlotId);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('SLOT_HAS_ACTIVE_ALLOCATION');
      expect(r.data.details.slotId).toBe(seed.mondaySlotId);
      const after = await slotsOf(seed.serviceId);
      expect(after.map((s) => [s.id, s.active])).toEqual([
        [seed.mondaySlotId, true],
        [seed.wednesdaySlotId, true],
      ]);
    } finally {
      await cleanupPatient(seed.patientId);
    }
  });

  it('(b) sem alocação → 200 e o slot de segunda desativa (como antes)', async () => {
    const seed = await seedService('b');
    try {
      const r = await patchService(seed, { schedule: [WEDNESDAY] });
      console.log('[12.5] (b) status', r.status);
      expect(r.status).toBe(200);
      const after = await slotsOf(seed.serviceId);
      expect(after.map((s) => [s.id, s.active])).toEqual([
        [seed.mondaySlotId, false],
        [seed.wednesdaySlotId, true],
      ]);
    } finally {
      await cleanupPatient(seed.patientId);
    }
  });

  it('(c) alocação ENDED com fim ontem → 200 e o slot de segunda desativa', async () => {
    const seed = await seedService('c');
    try {
      await allocate(seed, seed.mondaySlotId, { validFrom: semanaAtras, validTo: ontem, status: 'ENDED' });
      const r = await patchService(seed, { schedule: [WEDNESDAY] });
      console.log('[12.5] (c) status', r.status, 'hoje', hoje, 'valid_to', ontem);
      expect(r.status).toBe(200);
      const after = await slotsOf(seed.serviceId);
      expect(after.find((s) => s.id === seed.mondaySlotId)?.active).toBe(false);
    } finally {
      await cleanupPatient(seed.patientId);
    }
  });

  it('(d) alocação ACTIVE vencida (fim ontem) → 200 e o slot de segunda desativa', async () => {
    const seed = await seedService('d');
    try {
      await allocate(seed, seed.mondaySlotId, { validFrom: semanaAtras, validTo: ontem, status: 'ACTIVE' });
      const r = await patchService(seed, { schedule: [WEDNESDAY] });
      console.log('[12.5] (d) status', r.status, 'hoje', hoje, 'valid_to', ontem);
      expect(r.status).toBe(200);
      const after = await slotsOf(seed.serviceId);
      expect(after.find((s) => s.id === seed.mondaySlotId)?.active).toBe(false);
    } finally {
      await cleanupPatient(seed.patientId);
    }
  });

  it('(e) schedule null com alocação vigente → 422, nenhum slot desativa', async () => {
    const seed = await seedService('e');
    try {
      await allocate(seed, seed.mondaySlotId, { validFrom: semanaAtras, validTo: null, status: 'ACTIVE' });
      const r = await patchService(seed, { schedule: null });
      console.log('[12.5] (e) status', r.status, 'code', r.data?.code, 'slotId==segunda', r.data?.details?.slotId === seed.mondaySlotId);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('SLOT_HAS_ACTIVE_ALLOCATION');
      expect(r.data.details.slotId).toBe(seed.mondaySlotId);
      const after = await slotsOf(seed.serviceId);
      expect(after.every((s) => s.active)).toBe(true);
      expect(after).toHaveLength(2);
    } finally {
      await cleanupPatient(seed.patientId);
    }
  });

  it('(f) PATCH só de weeklyHours com alocação vigente → 200, slots intocados', async () => {
    const seed = await seedService('f');
    try {
      await allocate(seed, seed.mondaySlotId, { validFrom: semanaAtras, validTo: null, status: 'ACTIVE' });
      const r = await patchService(seed, { weeklyHours: 12 });
      console.log('[12.5] (f) status', r.status);
      expect(r.status).toBe(200);
      const after = await slotsOf(seed.serviceId);
      expect(after.map((s) => [s.id, s.active])).toEqual([
        [seed.mondaySlotId, true],
        [seed.wednesdaySlotId, true],
      ]);
    } finally {
      await cleanupPatient(seed.patientId);
    }
  });

  it('(g) rota da Fase 11 (PATCH do slot) com o slot alocado segue 422', async () => {
    const seed = await seedService('g');
    try {
      await allocate(seed, seed.mondaySlotId, { validFrom: semanaAtras, validTo: null, status: 'ACTIVE' });
      const r = await api.patch(
        `/api/admin/patients/${seed.patientId}/contracted-services/${seed.serviceId}/itinerary/slots/${seed.mondaySlotId}`,
        { weekday: 1, startTime: '09:00', endTime: '12:00' },
        asAdmin,
      );
      console.log('[12.5] (g) status', r.status, 'code', r.data?.code);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('SLOT_HAS_ACTIVE_ALLOCATION');
      const after = await slotsOf(seed.serviceId);
      expect(after.map((s) => [s.id, s.active])).toEqual([
        [seed.mondaySlotId, true],
        [seed.wednesdaySlotId, true],
      ]);
    } finally {
      await cleanupPatient(seed.patientId);
    }
  });
});
