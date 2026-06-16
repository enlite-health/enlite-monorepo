/**
 * blocked-application-repos.integration.test.ts
 *
 * Testes de integração com banco REAL para:
 *   - BlockedApplicationRepository.upsert (write side)
 *   - BlockedApplicationQueryRepository.list + aggregates (read side)
 *
 * Não usa API — acessa pool diretamente.
 * INVARIANTE: migration 209 deve estar aplicada.
 *
 * Branches SQL de fn_worker_missing_fields ficam em:
 *   tests/e2e/fn-worker-missing-fields.integration.test.ts
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ALL_WORKER_IDS: string[] = [];
let PATIENT_ID: string;
let VACANCY_ID: string;

// ── Helpers ────────────────────────────────────────────────────────────

async function makeWorker(
  status: 'INCOMPLETE_REGISTER' | 'DISABLED' | 'REGISTERED',
  tag: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-repos-${SUFFIX}-${tag}`, `repos-${SUFFIX}-${tag}@blocked.test`, status],
  );
  ALL_WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

// ── Global setup/teardown ──────────────────────────────────────────────

beforeAll(async () => {
  const { rows: pRows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'E2E', 'ReposBlocked', 'AR', 'ACTIVE') RETURNING id`,
    [`e2e-repos-${SUFFIX}`],
  );
  PATIENT_ID = pRows[0].id;

  const { rows: vRows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, country, status, patient_id, case_number)
     VALUES ('Vaga Repos Blocked', 'AR', 'SEARCHING', $1, 99993) RETURNING id`,
    [PATIENT_ID],
  );
  VACANCY_ID = vRows[0].id;
});

afterAll(async () => {
  if (ALL_WORKER_IDS.length) {
    await pool.query(
      `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`,
      [ALL_WORKER_IDS],
    );
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
  }
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [VACANCY_ID]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  await pool.end();
});

// ── 1. BlockedApplicationRepository.upsert ────────────────────────────

describe('BlockedApplicationRepository (banco real)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BlockedApplicationRepository } = require('../../src/modules/matching/infrastructure/BlockedApplicationRepository') as typeof import('../../src/modules/matching/infrastructure/BlockedApplicationRepository');

  const upsertWorkerIds: string[] = [];

  afterEach(async () => {
    if (upsertWorkerIds.length) {
      await pool.query(
        `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`,
        [upsertWorkerIds],
      );
      upsertWorkerIds.length = 0;
    }
  });

  it('primeira tentativa cria linha com attempt_count=1', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'upsert-1');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'registration_incomplete', acquisitionChannel: 'facebook' });

    const { rows } = await pool.query(
      `SELECT attempt_count, blocked_reason, acquisition_channel, missing_fields
       FROM worker_blocked_applications WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, VACANCY_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_count).toBe(1);
    expect(rows[0].blocked_reason).toBe('registration_incomplete');
    expect(rows[0].acquisition_channel).toBe('facebook');
    expect(Array.isArray(rows[0].missing_fields)).toBe(true);
  });

  it('segunda tentativa incrementa attempt_count SEM duplicar linha', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'upsert-2');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'registration_incomplete', acquisitionChannel: 'site' });
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'registration_incomplete', acquisitionChannel: 'linkedin' });

    const { rows } = await pool.query(
      `SELECT attempt_count, acquisition_channel, first_attempted_at, last_attempted_at
       FROM worker_blocked_applications WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, VACANCY_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_count).toBe(2);
    expect(rows[0].acquisition_channel).toBe('site'); // first-value-wins
    expect((rows[0].last_attempted_at as Date).getTime()).toBeGreaterThanOrEqual(
      (rows[0].first_attempted_at as Date).getTime(),
    );
  });

  it('acquisition_channel first-value-wins (COALESCE)', async () => {
    const workerId = await makeWorker('DISABLED', 'upsert-coalesce');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'worker_disabled', acquisitionChannel: 'whatsapp' });
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'worker_disabled', acquisitionChannel: 'instagram' });

    const { rows } = await pool.query(`SELECT acquisition_channel FROM worker_blocked_applications WHERE worker_id = $1`, [workerId]);
    expect(rows[0].acquisition_channel).toBe('whatsapp');
  });

  it('reason=worker_disabled → missing_fields=[]', async () => {
    const workerId = await makeWorker('DISABLED', 'upsert-disabled');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'worker_disabled', acquisitionChannel: null });

    const { rows } = await pool.query(`SELECT missing_fields, blocked_reason FROM worker_blocked_applications WHERE worker_id = $1`, [workerId]);
    expect(rows[0].missing_fields).toEqual([]);
    expect(rows[0].blocked_reason).toBe('worker_disabled');
  });

  it('reason=worker_not_found → missing_fields contém "worker_not_found"', async () => {
    const nonExistentId = '00000000-0000-0000-0000-000000000003';
    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId: nonExistentId, jobPostingId: VACANCY_ID, reason: 'worker_not_found', acquisitionChannel: 'site' });

    const { rows } = await pool.query(`SELECT missing_fields FROM worker_blocked_applications WHERE worker_id = $1`, [nonExistentId]);
    await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = $1`, [nonExistentId]);

    expect(rows).toHaveLength(1);
    expect(rows[0].missing_fields).toContain('worker_not_found');
  });

  it('missing_fields preenchido para worker incompleto', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'upsert-missing');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'registration_incomplete', acquisitionChannel: null });

    const { rows } = await pool.query(`SELECT missing_fields FROM worker_blocked_applications WHERE worker_id = $1`, [workerId]);
    expect(rows[0].missing_fields.length).toBeGreaterThan(0);
  });
});

// ── 2. BlockedApplicationQueryRepository.list/aggregates ─────────────

describe('BlockedApplicationQueryRepository (banco real)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BlockedApplicationQueryRepository } = require('../../src/modules/matching/infrastructure/BlockedApplicationQueryRepository') as typeof import('../../src/modules/matching/infrastructure/BlockedApplicationQueryRepository');

  const qWorkerIds: string[] = [];
  let qVacancyId: string;
  let qPatientId: string;
  let qWorkerInc: string;
  let qWorkerDis: string;

  beforeAll(async () => {
    const { rows: pRows } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'E2E', 'QueryBlocked2', 'AR', 'ACTIVE') RETURNING id`,
      [`e2e-qblk2-${SUFFIX}`],
    );
    qPatientId = pRows[0].id;

    const { rows: vRows } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Vaga Query Blocked 2', 'AR', 'SEARCHING', $1, 99994) RETURNING id`,
      [qPatientId],
    );
    qVacancyId = vRows[0].id;

    qWorkerInc = await makeWorker('INCOMPLETE_REGISTER', 'query-inc');
    qWorkerDis = await makeWorker('DISABLED', 'query-dis');
    qWorkerIds.push(qWorkerInc, qWorkerDis);

    await pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason, missing_fields, acquisition_channel,
          attempt_count, first_attempted_at, last_attempted_at)
       VALUES
         ($1, $2, 'registration_incomplete', '["phone"]', 'facebook', 2, NOW()-interval '2m', NOW()-interval '1m'),
         ($3, $2, 'worker_disabled', '[]', 'instagram', 1, NOW(), NOW())`,
      [qWorkerInc, qVacancyId, qWorkerDis],
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[]) OR job_posting_id = $2`,
      [qWorkerIds, qVacancyId],
    );
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [qVacancyId]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [qPatientId]);
  });

  it('filtra por jobPostingId — total=2, todos com qVacancyId', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, limit: 100, offset: 0 });
    expect(result.total).toBe(2);
    for (const item of result.data) expect(item.jobPostingId).toBe(qVacancyId);
  });

  it('filtra por workerId', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ workerId: qWorkerInc, limit: 100, offset: 0 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    for (const item of result.data) expect(item.workerId).toBe(qWorkerInc);
  });

  it('filtra por reason=registration_incomplete', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ reason: 'registration_incomplete', limit: 100, offset: 0 });
    for (const item of result.data) expect(item.blockedReason).toBe('registration_incomplete');
  });

  it('filtra por reason=worker_disabled', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ reason: 'worker_disabled', limit: 100, offset: 0 });
    for (const item of result.data) expect(item.blockedReason).toBe('worker_disabled');
  });

  it('paginação: limit=1 retorna 1 item, total=2', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, limit: 1, offset: 0 });
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  it('paginação: offset=2 retorna data=[], total=2', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, limit: 10, offset: 2 });
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(2);
  });

  it('ordenação por last_attempted_at DESC', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, limit: 100, offset: 0 });
    if (result.data.length >= 2) {
      const first = new Date(result.data[0].lastAttemptedAt).getTime();
      const second = new Date(result.data[1].lastAttemptedAt).getTime();
      expect(first).toBeGreaterThanOrEqual(second);
    }
  });

  it('DTO com todos os campos mapeados', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ workerId: qWorkerInc, limit: 1, offset: 0 });
    expect(result.data).toHaveLength(1);
    const item = result.data[0];
    expect(typeof item.id).toBe('string');
    expect(item.workerId).toBe(qWorkerInc);
    expect(item.jobPostingId).toBe(qVacancyId);
    expect(item.blockedReason).toBe('registration_incomplete');
    expect(Array.isArray(item.missingFields)).toBe(true);
    expect(item.attemptCount).toBe(2);
    expect(typeof item.firstAttemptedAt).toBe('string');
    expect(typeof item.lastAttemptedAt).toBe('string');
    expect(item.acquisitionChannel).toBe('facebook');
  });

  it('filtros combinados: jobPostingId + workerId → total=1', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, workerId: qWorkerInc, limit: 10, offset: 0 });
    expect(result.total).toBe(1);
  });

  it('aggregates: totalBlocked === soma de byReason', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const agg = await repo.aggregates();
    const sum = Object.values(agg.byReason).reduce((acc, v) => acc + v, 0);
    expect(agg.totalBlocked).toBe(sum);
    expect(agg.byReason).toMatchObject({ registration_incomplete: expect.any(Number) });
  });
});
