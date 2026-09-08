/**
 * blocked-application-promotion.e2e.test.ts
 *
 * E2E do fluxo de promoção automática de tentativas bloqueadas:
 *
 *   1. Worker tenta postular sem estar REGISTERED → 403 + linha em
 *      worker_blocked_applications (blocked_reason_at_attempt=registration_incomplete).
 *   2. Card aparece em stages.BLOQUEADO no funil (não em INICIADO).
 *   3. Worker completa o cadastro (INFO + service_area + availability + docs)
 *      → status vira REGISTERED → recalculateWorkerStatus enfileira
 *      domain_events (worker.mirror_requested + worker.registration_completed)
 *      na mesma transação.
 *   4. Processa o evento worker.registration_completed via
 *      POST /api/internal/events/process (mesmo padrão de auto-invite.e2e.test.ts —
 *      Pub/Sub push simulado).
 *   5. PromoteBlockedApplicationsUseCase cria worker_job_applications
 *      (source='manual', stage='INVITED') e seta promoted_at/promoted_wja_id
 *      na linha bloqueada.
 *   6. Funil agora mostra o card em stages.INICIADO (WJA real) e stages.BLOQUEADO
 *      fica vazio para esse worker (listByVacancy: NOT EXISTS já exclui a linha
 *      promovida).
 *
 * Banco real (Docker via DATABASE_URL). Zero mocks.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import {
  createWorker,
  createVacancyFixture,
  getWorkerToken,
  savePersonalInfo,
  saveServiceArea,
  saveAvailability,
  saveDocuments,
  tryApply,
  getWorkerStatus,
  cleanupJourneyData,
  DOCS_NON_AT,
  JourneyWorker,
  JourneyVacancy,
} from './worker-onboarding-journey.helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

async function waitForCondition(
  fn: () => Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 300,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

describe('Promoção automática de tentativas bloqueadas (worker.registration_completed)', () => {
  const api = createApiClient();
  let pool: Pool;
  let adminToken: string;
  let worker: JourneyWorker;
  let vacancy: JourneyVacancy;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    adminToken = await getMockToken(api, {
      uid: 'blocked-promo-admin',
      email: 'blocked-promo-admin@e2e.local',
      role: 'admin',
    });

    vacancy = await createVacancyFixture(pool, 'blocked-promo');
    // createVacancyFixture não seta is_draft (default TRUE) — a guarda (a) de
    // PromoteBlockedApplicationsUseCase exige is_draft=false (vaga publicada).
    await pool.query(`UPDATE job_postings SET is_draft = false WHERE id = $1`, [vacancy.id]);
    worker = await createWorker(api, 'blocked-promo');
  });

  afterAll(async () => {
    if (pool) {
      await cleanupJourneyData(pool, [worker?.id].filter(Boolean) as string[], [vacancy.id], [vacancy.patientId]);
      await pool.query(
        `DELETE FROM domain_events WHERE payload->>'workerId' = $1`,
        [worker.id],
      ).catch(() => {});
      await pool.end();
    }
  });

  it('1. worker incompleto tenta postular → 403 + linha bloqueada', async () => {
    const token = await getWorkerToken(api, worker);

    const applyResult = await tryApply(api, token, vacancy.id);
    expect(applyResult.status).toBe(403);
    expect(applyResult.data.code).toBe('WORKER_NOT_ELIGIBLE');

    const { rows } = await pool.query(
      `SELECT blocked_reason_at_attempt, promoted_at FROM worker_blocked_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [worker.id, vacancy.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked_reason_at_attempt).toBe('registration_incomplete');
    expect(rows[0].promoted_at).toBeNull();
  });

  it('2. card aparece em stages.BLOQUEADO no funil (não em INICIADO)', async () => {
    const res = await api.get(`/api/admin/vacancies/${vacancy.id}/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);

    const { stages } = res.data.data;
    const bloqueadoIds = (stages.BLOQUEADO as Array<{ workerId: string }>).map(c => c.workerId);
    expect(bloqueadoIds).toContain(worker.id);

    const iniciadoIds = (stages.INICIADO as Array<{ workerId: string }>).map(c => c.workerId);
    expect(iniciadoIds).not.toContain(worker.id);
  });

  it('3. worker completa cadastro → status vira REGISTERED e enfileira worker.registration_completed', async () => {
    const token = await getWorkerToken(api, worker);

    await savePersonalInfo(api, token, worker.id);
    await saveServiceArea(api, token);
    await saveAvailability(api, token);
    await saveDocuments(api, token, DOCS_NON_AT);

    const status = await getWorkerStatus(pool, worker.id);
    expect(status).toBe('REGISTERED');

    await waitForCondition(async () => {
      const { rows } = await pool.query(
        `SELECT id FROM domain_events
         WHERE event = 'worker.registration_completed' AND payload->>'workerId' = $1`,
        [worker.id],
      );
      return rows.length > 0;
    });

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM domain_events
       WHERE event = 'worker.registration_completed' AND payload->>'workerId' = $1`,
      [worker.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
  });

  it('4-5. processa o evento → WJA INVITED+manual criada e blocked attempt promovido', async () => {
    const { rows: evtRows } = await pool.query<{ id: string }>(
      `SELECT id FROM domain_events
       WHERE event = 'worker.registration_completed' AND payload->>'workerId' = $1
       LIMIT 1`,
      [worker.id],
    );
    expect(evtRows.length).toBeGreaterThan(0);
    const eventId = evtRows[0].id;

    const pubsubPayload = Buffer.from(JSON.stringify({ eventId })).toString('base64');
    const processRes = await api.post(
      '/api/internal/events/process',
      { message: { data: pubsubPayload } },
      { headers: { 'X-Internal-Secret': INTERNAL_SECRET } },
    );
    expect([200, 204]).toContain(processRes.status);

    await waitForCondition(async () => {
      const { rows } = await pool.query(
        `SELECT id FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
        [worker.id, vacancy.id],
      );
      return rows.length > 0;
    });

    const { rows: wjaRows } = await pool.query(
      `SELECT id, source, application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [worker.id, vacancy.id],
    );
    expect(wjaRows).toHaveLength(1);
    expect(wjaRows[0].source).toBe('manual');
    expect(wjaRows[0].application_funnel_stage).toBe('INVITED');

    const { rows: blockedRows } = await pool.query(
      `SELECT promoted_at, promoted_wja_id FROM worker_blocked_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [worker.id, vacancy.id],
    );
    expect(blockedRows).toHaveLength(1);
    expect(blockedRows[0].promoted_at).not.toBeNull();
    expect(blockedRows[0].promoted_wja_id).toBe(wjaRows[0].id);
  });

  it('6. funil mostra o card em INICIADO e BLOQUEADO fica vazio pra esse worker', async () => {
    const res = await api.get(`/api/admin/vacancies/${vacancy.id}/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);

    const { stages } = res.data.data;
    const iniciadoIds = (stages.INICIADO as Array<{ workerId: string }>).map(c => c.workerId);
    expect(iniciadoIds).toContain(worker.id);

    const bloqueadoIds = (stages.BLOQUEADO as Array<{ workerId: string }>).map(c => c.workerId);
    expect(bloqueadoIds).not.toContain(worker.id);
  });
});
