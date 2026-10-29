/**
 * service-team-reader-read-many.e2e.test.ts @integration — spec 056, T6.2b
 *
 * Prova, contra Postgres real e sem API, a SQL de `ServiceTeamReader.readManyWith` (lote por serviço) e a
 * equivalência com `readWith`. O leitor recebe o `client` do `pg` direto (não abre transação); o usuário do
 * teste é o dono do schema, então não há RLS/ator a carimbar — `withActorContext` não é necessário aqui.
 */
import { Pool } from 'pg';
import { ServiceTeamReader } from '../../src/modules/case/infrastructure/ServiceTeamReader';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `stro-e2e-${RUN}-`;

describe('ServiceTeamReader.readManyWith — lote por serviço — contra Postgres real @integration', () => {
  let pool: Pool;
  let patientId = '';
  let otherPatientId = '';
  let serviceA = '';
  let serviceB = '';
  let vacancyA = '';
  let vacancyB = '';
  const workerIds: string[] = [];

  async function mkPatient(label: string): Promise<string> {
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Leitor', 'Lote', 'AR', 'ACTIVE') RETURNING id`,
        [`${PREFIX}${label}`],
      )
    ).rows[0].id;
  }

  async function mkServiceWithSlotAndVacancy(pid: string, label: string): Promise<{ serviceId: string; vacancyId: string }> {
    const addressId = (
      await pool.query<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`, [pid])
    ).rows[0].id;
    const serviceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [pid, addressId, PREFIX],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
       VALUES ($1, 1, '08:00', 120, '[2026-01-01,)'::daterange, $2, $2)`,
      [serviceId, PREFIX],
    );
    const vacancyId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${PREFIX}vaga-${label}`, serviceId, pid],
      )
    ).rows[0].id;
    return { serviceId, vacancyId };
  }

  async function mkQrtWorker(label: string, vacancyId: string): Promise<void> {
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country, timezone, status)
         VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED') RETURNING id`,
        [`${PREFIX}uid-${label}`, `${PREFIX}${label}@enlite-test.invalid`],
      )
    ).rows[0].id;
    workerIds.push(workerId);
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'talentum')`,
      [workerId, vacancyId],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await mkPatient('p1');
    otherPatientId = await mkPatient('p2');
    ({ serviceId: serviceA, vacancyId: vacancyA } = await mkServiceWithSlotAndVacancy(patientId, 'A'));
    ({ serviceId: serviceB, vacancyId: vacancyB } = await mkServiceWithSlotAndVacancy(patientId, 'B'));
    await mkQrtWorker('w1', vacancyA);
    await mkQrtWorker('w2', vacancyA);
  });

  afterAll(async () => {
    try {
      await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`, [`${PREFIX}%`]);
      await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, [`${PREFIX}%`]);
      await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${PREFIX}%`]);
      await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
      const left = await pool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM job_postings WHERE title LIKE $1)::int
              + (SELECT count(*) FROM workers WHERE auth_uid LIKE $1)::int
              + (SELECT count(*) FROM patients WHERE clickup_task_id LIKE $1)::int AS n`,
        [`${PREFIX}%`],
      );
      if (left.rows[0].n !== 0) throw new Error(`limpeza incompleta do RUN ${RUN}: restam ${left.rows[0].n}`);
    } finally {
      await pool.end();
    }
  });

  it('readManyWith([A, B]): A com a vaga viva e 2 candidatos em QRT; B com a vaga viva e 0', async () => {
    const client = await pool.connect();
    try {
      const rows = await new ServiceTeamReader().readManyWith(client, [serviceA, serviceB]);
      const byService = new Map(rows.map((r) => [r.serviceId, r]));
      expect(rows).toHaveLength(2);
      expect(byService.get(serviceA)?.liveVacancyId).toBe(vacancyA);
      expect(byService.get(serviceB)?.liveVacancyId).toBe(vacancyB);
      expect(byService.get(serviceA)?.candidacies.filter((c) => c.stage === 'QUICK_RESPONSE_TEAM')).toHaveLength(2);
      expect(byService.get(serviceB)?.candidacies).toHaveLength(0);
      expect(byService.get(serviceA)?.country).toBe('AR');
    } finally {
      client.release();
    }
  });

  it('readWith(A) devolve a mesma linha de A que o lote; readWith(A) com OUTRO patientId → null (404)', async () => {
    const client = await pool.connect();
    try {
      const reader = new ServiceTeamReader();
      const [fromBatchA] = (await reader.readManyWith(client, [serviceA, serviceB])).filter((r) => r.serviceId === serviceA);
      const single = await reader.readWith(client, patientId, serviceA);
      expect(single).toEqual(fromBatchA);
      expect(single?.candidacies).toHaveLength(2);
      expect(await reader.readWith(client, otherPatientId, serviceA)).toBeNull();
    } finally {
      client.release();
    }
  });
});
