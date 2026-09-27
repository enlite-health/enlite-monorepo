/**
 * patient-itinerary-schema.e2e.test.ts @integration — cadeia-paciente-vacante-itinerario, Fase 7, P2
 *
 * Prova, contra Postgres real, as regras de `patient_itinerary_slot` / `patient_itinerary_assignment`
 * escritas na migration 480 (DX-7.1):
 *   (a) CHECKs e UNIQUE do slot — pis_weekday_range, pis_time_order, pis_service_slot_uq — e o
 *       trigger que herda `country` do serviço.
 *   (b) NOT NULL / FK / CHECKs da alocação, o trigger de candidatura (invariante 5 —
 *       "candidato DAQUELA vaga") e `uq_pia_open_pair` (o mesmo prestador não abre duas vezes o
 *       mesmo slot; outro prestador pode — pergunta P2 do Diego).
 *   (c) a purga do paciente (D248) leva serviço + slot em cascata (ON DELETE CASCADE).
 *   (d) GRANT/REVOKE: `app_runtime` sem DELETE, com INSERT/UPDATE/SELECT — nas duas tabelas.
 *   (e) invariante 8: nenhuma das duas tem `address_id` (controle: `patient_contracted_services` tem).
 *
 * Semente por SQL no beforeAll, como dono (nunca pela API — a API é do P9, DX-7.9): 2 pacientes AR,
 * 1 serviço cada (cada um com endereço próprio, nenhum com `schedule` — a derivação é do P5), 1 vaga
 * por serviço (`job_postings.contracted_service_id`), 2 workers, 1 WJA de cada worker na vaga do
 * serviço 1 e 1 WJA do worker 1 na vaga do serviço 2 (usada pelo caso "candidatura de outra vaga").
 *
 * `source='import'` nas WJAs: bypassa o guard `enforce_worker_registered_for_application`
 * (migrations 183/205 — exige `workers.status='REGISTERED'`, que é OUTRA regra, do funil de
 * postulação, não do itinerário). `import` é um dos bypasses já vivos do trigger (backfill).
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pis-e2e-${RUN}-`;

interface PgErrorLike {
  code?: string;
  constraint?: string;
  column?: string;
  message: string;
}

async function expectPgError(query: Promise<unknown>): Promise<PgErrorLike> {
  let caught: PgErrorLike | null = null;
  try {
    await query;
  } catch (e) {
    caught = e as PgErrorLike;
  }
  if (!caught) {
    throw new Error('esperava erro do Postgres, mas o INSERT foi aceito');
  }
  return caught;
}

describe('patient_itinerary_slot / patient_itinerary_assignment — regras do banco (migration 480) @integration', () => {
  let pool: Pool;

  let patient1 = '';
  let patient2 = '';
  let service1 = '';
  let service2 = '';
  let job1 = '';
  let job2 = '';
  let worker1 = '';
  let worker2 = '';
  let wjaW1Job1 = '';
  let wjaW2Job1 = '';
  let wjaW1Job2 = '';
  let slot1 = '';
  let slot2 = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    patient1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'Uno', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p1`],
      )
    ).rows[0].id;
    patient2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'Dos', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p2`],
      )
    ).rows[0].id;

    const address1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patient1],
      )
    ).rows[0].id;
    const address2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patient2],
      )
    ).rows[0].id;

    service1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patient1, address1, TASK_PREFIX],
      )
    ).rows[0].id;
    service2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patient2, address2, TASK_PREFIX],
      )
    ).rows[0].id;

    job1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${TASK_PREFIX}vaga1`, service1, patient1],
      )
    ).rows[0].id;
    job2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${TASK_PREFIX}vaga2`, service2, patient2],
      )
    ).rows[0].id;

    worker1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}w1`, `${TASK_PREFIX}w1@e2e.local`],
      )
    ).rows[0].id;
    worker2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}w2`, `${TASK_PREFIX}w2@e2e.local`],
      )
    ).rows[0].id;

    wjaW1Job1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [worker1, job1],
      )
    ).rows[0].id;
    wjaW2Job1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [worker2, job1],
      )
    ).rows[0].id;
    wjaW1Job2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [worker1, job2],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    // Ordem: alocações → WJA → vagas → workers → pacientes (o serviço/slot do paciente 1 vai
    // junto do paciente por ON DELETE CASCADE; o do paciente 2 já saiu no teste (c)).
    await pool.query(
      `DELETE FROM patient_itinerary_assignment WHERE slot_id IN (
         SELECT id FROM patient_itinerary_slot WHERE contracted_service_id = $1
       )`,
      [service1],
    );
    await pool.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id = $1`, [service1]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [job1]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [job1]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [[worker1, worker2]]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.end();
  });

  // ── (a) slot ────────────────────────────────────────────────────────────────

  it('(a) slot com weekday fora de 0-6 → 23514 pis_weekday_range', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 7, '08:00', '09:00', $2, $2)`,
        [service1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('pis_weekday_range');
  });

  it('(a) slot com end_time = start_time → 23514 pis_time_order', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 2, '09:00', '09:00', $2, $2)`,
        [service1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('pis_time_order');
  });

  it('(a) o mesmo (service, weekday, start, end) 2x → 23505 pis_service_slot_uq', async () => {
    const first = await pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
       VALUES ($1, 1, '08:00', '09:00', $2, $2) RETURNING id`,
      [service1, TASK_PREFIX],
    );
    slot1 = first.rows[0].id;

    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 1, '08:00', '09:00', $2, $2)`,
        [service1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('pis_service_slot_uq');
  });

  it('(a) country do slot é herdado do serviço pelo trigger', async () => {
    const r = await pool.query<{ id: string; country: string }>(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
       VALUES ($1, 3, '08:00', '10:00', $2, $2) RETURNING id, country`,
      [service2, TASK_PREFIX],
    );
    slot2 = r.rows[0].id;
    expect(r.rows[0].country).toBe('AR');
  });

  // ── (b) alocação ────────────────────────────────────────────────────────────

  it('(b) application_id NULL → 23502 (critério 10, lado 1)', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, created_by, updated_by)
         VALUES ($1, $2, NULL, '2026-01-01', $3, $3)`,
        [slot1, worker1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23502');
  });

  it('(b) com a WJA certa → aceita (lado 2) e country herdado do slot', async () => {
    const r = await pool.query<{ id: string; country: string }>(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, created_by, updated_by)
       VALUES ($1, $2, $3, '2026-01-01', $4, $4) RETURNING id, country`,
      [slot1, worker1, wjaW1Job1, TASK_PREFIX],
    );
    expect(r.rows[0].country).toBe('AR');
  });

  it('(b) application_id inexistente → 23503', async () => {
    // worker2 (não worker1): o `it` anterior deixou uma linha ACTIVE em (slot1, worker1) — usar o
    // mesmo par faria o índice único parcial uq_pia_open_pair (23505) recusar o INSERT antes de a
    // FK (AFTER ROW) rodar. (slot1, worker2) ainda não tem alocação aberta neste ponto do arquivo.
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, created_by, updated_by)
         VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', '2026-01-01', $3, $3)`,
        [slot1, worker2, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23503');
  });

  it('(b) WJA de outro worker → 23514 pia_candidatura_de_outro_prestador', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-01-01', $4, $4)`,
        [slot1, worker2, wjaW1Job1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('pia_candidatura_de_outro_prestador');
  });

  it('(b) WJA do mesmo worker na vaga do serviço 2 → 23514 pia_candidatura_de_outra_vaga', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-01-01', $4, $4)`,
        [slot1, worker1, wjaW1Job2, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('pia_candidatura_de_outra_vaga');
  });

  it("(b) status = 'PAUSED' → 23514 pia_status_check", async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-01-01', 'PAUSED', $4, $4)`,
        [slot1, worker2, wjaW2Job1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('pia_status_check');
  });

  it("(b) status = 'ENDED' sem valid_to → 23514 pia_ended_has_end", async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-01-01', 'ENDED', $4, $4)`,
        [slot1, worker2, wjaW2Job1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('pia_ended_has_end');
  });

  it('(b) valid_to < valid_from → 23514 pia_valid_range', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-01-10', '2026-01-01', $4, $4)`,
        [slot1, worker2, wjaW2Job1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('pia_valid_range');
  });

  it('(b) 2ª alocação aberta do mesmo worker no mesmo slot → 23505 uq_pia_open_pair', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-02-01', $4, $4)`,
        [slot1, worker1, wjaW1Job1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('uq_pia_open_pair');
  });

  it('(b) outro worker aberto no mesmo slot → aceita (P2 — N prestadores por slot)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, created_by, updated_by)
       VALUES ($1, $2, $3, '2026-01-01', $4, $4) RETURNING id`,
      [slot1, worker2, wjaW2Job1, TASK_PREFIX],
    );
    expect(r.rows[0].id).toBeTruthy();
  });

  // ── (c) purga do paciente ────────────────────────────────────────────────────

  it('(c) DELETE FROM patients do paciente 2 (sem alocação) leva serviço e slot em cascata', async () => {
    const before = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_itinerary_slot WHERE id = $1`,
      [slot2],
    );
    expect(before.rows[0].n).toBe(1);

    // job_postings referencia patients (NO ACTION) — sai primeiro, mesma ordem do purge real
    // (PatientTestFixtureService / D248); worker_job_applications.job_posting_id cai em cascata.
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [job2]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patient2]);

    const afterService = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_contracted_services WHERE id = $1`,
      [service2],
    );
    expect(afterService.rows[0].n).toBe(0);

    const afterSlot = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_itinerary_slot WHERE id = $1`,
      [slot2],
    );
    expect(afterSlot.rows[0].n).toBe(0);
  });

  // ── (d) grants ────────────────────────────────────────────────────────────────

  it('(d) app_runtime sem DELETE, com INSERT/UPDATE/SELECT — nas duas tabelas', async () => {
    const r = await pool.query<{
      slot_delete: boolean;
      slot_insert: boolean;
      slot_update: boolean;
      slot_select: boolean;
      assignment_delete: boolean;
      assignment_insert: boolean;
      assignment_update: boolean;
      assignment_select: boolean;
    }>(
      `SELECT
         has_table_privilege('app_runtime', 'patient_itinerary_slot', 'DELETE') AS slot_delete,
         has_table_privilege('app_runtime', 'patient_itinerary_slot', 'INSERT') AS slot_insert,
         has_table_privilege('app_runtime', 'patient_itinerary_slot', 'UPDATE') AS slot_update,
         has_table_privilege('app_runtime', 'patient_itinerary_slot', 'SELECT') AS slot_select,
         has_table_privilege('app_runtime', 'patient_itinerary_assignment', 'DELETE') AS assignment_delete,
         has_table_privilege('app_runtime', 'patient_itinerary_assignment', 'INSERT') AS assignment_insert,
         has_table_privilege('app_runtime', 'patient_itinerary_assignment', 'UPDATE') AS assignment_update,
         has_table_privilege('app_runtime', 'patient_itinerary_assignment', 'SELECT') AS assignment_select`,
    );
    const row = r.rows[0];
    expect(row.slot_delete).toBe(false);
    expect(row.slot_insert).toBe(true);
    expect(row.slot_update).toBe(true);
    expect(row.slot_select).toBe(true);
    expect(row.assignment_delete).toBe(false);
    expect(row.assignment_insert).toBe(true);
    expect(row.assignment_update).toBe(true);
    expect(row.assignment_select).toBe(true);
  });

  // ── (e) invariante 8 ──────────────────────────────────────────────────────────

  it('(e) nenhuma das duas tabelas tem address_id (patient_contracted_services tem)', async () => {
    const noAddress = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name IN ('patient_itinerary_slot', 'patient_itinerary_assignment') AND column_name = 'address_id'`,
    );
    expect(noAddress.rows[0].n).toBe(0);

    const control = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'patient_contracted_services' AND column_name = 'address_id'`,
    );
    expect(control.rows[0].n).toBe(1);
  });
});
