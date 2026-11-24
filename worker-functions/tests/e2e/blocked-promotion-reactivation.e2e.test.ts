/**
 * blocked-promotion-reactivation.e2e.test.ts @integration — spec 093 CA-5.
 *
 * Reativação de baixa administrativa (ReactivateArchivedWorkerUseCase, caminho real) de um worker COMPLETO com
 * tentativa bloqueada pendente: fluxo ARCHIVE_REACTIVATION → REGISTERED → worker.registration_completed → o evento é
 * processado pelo DomainEventProcessor (o mesmo `processEvent` que o sweep chama) → WJA criada e promoted_at preenchido.
 * Nenhum Pub/Sub nem Twilio: o caminho não recebe pubsub e o teste prova `messaging_outbox` vazio.
 */
import { Pool } from 'pg';
import { reactivateIfArchivedByUs } from '../../src/modules/worker/application/ReactivateArchivedWorkerUseCase';
import { DomainEventProcessor } from '../../src/shared/events/DomainEventProcessor';
import { createPromoteBlockedApplicationsHandler } from '../../src/modules/matching/application/PromoteBlockedApplicationsEventHandler';
import { completeWorkerProfile, cleanWorkerProfile } from './helpers/aptoWorkerFixture';
import { setWorkerStatusForTest } from './helpers/setWorkerStatusForTest';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const PREFIX = 'br093-';
const ARQUIVADOR = 'system:bulk-archive-stale-2026-01-30';

describe('Spec 093 CA-5 — reativação promove a tentativa bloqueada @integration', () => {
  let pool: Pool;
  let workerId = '';
  let blockedId = '';
  let patientId = '';
  let jobPostingId = '';

  const limpar = async (): Promise<void> => {
    const w = `SELECT id FROM workers WHERE auth_uid LIKE '${PREFIX}%'`;
    await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' IN (SELECT id::text FROM (${w}) x)`);
    await pool.query(`DELETE FROM encuadres WHERE worker_id IN (${w})`);
    await pool.query(`DELETE FROM worker_job_application_stage_history WHERE application_id IN (SELECT id FROM worker_job_applications WHERE worker_id IN (${w}))`);
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id IN (${w})`);
    await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id IN (${w})`);
    await pool.query(`DELETE FROM worker_status_history WHERE worker_id IN (${w})`);
    await cleanWorkerProfile(pool, (await pool.query<{ id: string }>(w)).rows.map((r) => r.id));
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE '${PREFIX}%'`);
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIX}%')`);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE '${PREFIX}%'`);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number)
       VALUES ($1, 'Br093', 'E2E', 'AR', 'ACTIVE', 930002) RETURNING id`, [`${PREFIX}pac`])).rows[0].id;
    jobPostingId = (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, vacancy_number, title, status, patient_id, country, is_draft, is_test, social_short_links)
       VALUES (930002, 930002, 'CASO BR093-E2E', 'SEARCHING', $1, 'AR', false, false, '{}'::jsonb) RETURNING id`, [patientId])).rows[0].id;

    workerId = (await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone, is_test)
       VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires', true) RETURNING id`,
      [`${PREFIX}w`, `${PREFIX}w@e2e.local`])).rows[0].id;
    await completeWorkerProfile(pool, workerId, 'validated');

    // Baixa administrativa do lote reversível (changed_by = ARQUIVADOR). O helper abre a própria transação e declara o
    // fluxo (TEST_FIXTURE); o ator vai no escopo da SESSÃO (set_config is_local=false) e é zerado ao devolver o client.
    const c = await pool.connect();
    try {
      await c.query(`SELECT set_config('app.current_uid', $1, false)`, [ARQUIVADOR]);
      await setWorkerStatusForTest(c, workerId, 'DISABLED');
    } finally {
      await c.query(`SELECT set_config('app.current_uid', '', false)`).catch(() => undefined);
      c.release();
    }

    blockedId = (await pool.query<{ id: string }>(
      `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason, acquisition_channel)
       VALUES ($1, $2, 'registration_incomplete', 'facebook') RETURNING id`, [workerId, jobPostingId])).rows[0].id;
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('reativa (ARCHIVE_REACTIVATION → REGISTERED), enfileira o evento e o processamento promove a tentativa', async () => {
    expect((await pool.query(`SELECT status FROM workers WHERE id = $1`, [workerId])).rows[0].status).toBe('DISABLED');

    const restaurado = await reactivateIfArchivedByUs(pool, workerId);
    expect(restaurado).toBe('REGISTERED');

    const h = await pool.query<{ new_value: string; flow: string }>(
      `SELECT new_value, flow FROM worker_status_history WHERE worker_id = $1 AND field_name = 'status' AND flow = 'ARCHIVE_REACTIVATION' ORDER BY created_at, id`,
      [workerId]);
    // mesma transação → created_at idêntico: compara o conjunto, não a ordem
    expect(h.rows.map((r) => r.new_value).sort()).toEqual(['INCOMPLETE_REGISTER', 'REGISTERED']);
    expect((await pool.query(`SELECT status FROM workers WHERE id = $1`, [workerId])).rows[0].status).toBe('REGISTERED');

    const ev = await pool.query<{ id: string }>(
      `SELECT id FROM domain_events WHERE event = 'worker.registration_completed' AND payload->>'workerId' = $1`, [workerId]);
    expect(ev.rows).toHaveLength(1);

    // Ainda não promovida: só o processamento do evento promove.
    expect((await pool.query(`SELECT promoted_at FROM worker_blocked_applications WHERE id = $1`, [blockedId])).rows[0].promoted_at).toBeNull();

    const processor = new DomainEventProcessor(pool);
    processor.registerHandler('worker.registration_completed', createPromoteBlockedApplicationsHandler(pool));
    expect((await processor.processEvent(ev.rows[0].id)).status).toBe('processed');

    const wja = await pool.query(`SELECT id FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`, [workerId, jobPostingId]);
    expect(wja.rows).toHaveLength(1);
    const bl = await pool.query(`SELECT promoted_at, promoted_wja_id FROM worker_blocked_applications WHERE id = $1`, [blockedId]);
    expect(bl.rows[0].promoted_at).not.toBeNull();
    expect(bl.rows[0].promoted_wja_id).toBe(wja.rows[0].id);

    expect(Number((await pool.query(`SELECT count(*) n FROM messaging_outbox WHERE worker_id = $1`, [workerId])).rows[0].n)).toBe(0);
  });
});
