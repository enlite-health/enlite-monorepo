/**
 * admin-worker-vacancy-delivery-status.test.ts
 *
 * E2E test for:
 *   GET /api/admin/vacancies/:vacancyId/workers/:workerId/delivery-status
 *
 * Cobre a lacuna apontada no review do PR #131: os testes existentes
 * (WorkerVacancyDeliveryStatusController.test.ts / workerVacancyDeliveryStatusHelper.test.ts)
 * mockam `db.query` inteiro — nenhum roda o SQL de verdade contra o schema real.
 * Contra o schema deste branch (parado na migration 181), a query do helper
 * quebraria: `messaging_outbox.channel` só nasce na migration 241. Este teste
 * roda a query real contra Postgres (docker), provando que ela funciona no
 * schema atual (branch já tem até a 248) e vai continuar funcionando em main.
 *
 * Cenários:
 *   (a) staff autenticado + par com WJA e outbox real → 200 com os campos certos
 *       (inclui: pega o outbox MAIS RECENTE quando há mais de um)
 *   (b) sem token → 401
 *   (c) token com role não-staff (worker) → 403
 *   (d) par sem WJA → 404 (comportamento definido no helper: kind === 'not_found')
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Deterministic IDs ─────────────────────────────────────────────────────────

const IDS = {
  patient: 'd0000001-0000-4000-a001-000000000001',
  vacancy: 'd0000001-0000-4000-a002-000000000001',
  worker: 'd0000001-0000-4000-a003-000000000001',
  workerNoWja: 'd0000001-0000-4000-a003-000000000002',
  wja: 'd0000001-0000-4000-a004-000000000001',
};

describe('GET /api/admin/vacancies/:vacancyId/workers/:workerId/delivery-status', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'ds-admin-e2e',
      email: 'ds-admin@e2e.local',
      role: 'admin',
    });
    workerToken = await getMockToken(api, {
      uid: 'ds-worker-e2e',
      email: 'ds-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
    await seedFixtures(pool);
  });

  afterAll(async () => {
    await cleanFixtures(pool);
    await pool.end();
  });

  function endpoint(workerId: string): string {
    return `/api/admin/vacancies/${IDS.vacancy}/workers/${workerId}/delivery-status`;
  }

  it('200: staff autenticado recebe wjaStage + outbox (o registro MAIS RECENTE) para um par worker/vaga real', async () => {
    const res = await api.get(endpoint(IDS.worker), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const data = res.data.data;
    expect(data.wjaStage).toBe('INVITED');
    expect(data.outbox).toEqual({
      status: 'sent',
      deliveryStatus: 'delivered',
      twilioSid: 'SM_DS_E2E_LATEST',
      channel: 'twilio',
      templateSlug: 'qualified_worker_request',
    });
  });

  it('401: sem token de autenticação', async () => {
    const res = await api.get(endpoint(IDS.worker));

    expect(res.status).toBe(401);
    expect(res.data.success).toBe(false);
  });

  it('403: token autenticado mas com role não-staff (worker)', async () => {
    const res = await api.get(endpoint(IDS.worker), {
      headers: { Authorization: `Bearer ${workerToken}` },
    });

    expect(res.status).toBe(403);
    expect(res.data.success).toBe(false);
  });

  it('404: par (worker, vaga) sem WJA nenhuma', async () => {
    const res = await api.get(endpoint(IDS.workerNoWja), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(404);
    expect(res.data.success).toBe(false);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function seedFixtures(pool: Pool): Promise<void> {
  await cleanFixtures(pool);

  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name)
     VALUES ($1, 'ds-e2e-task-001', 'AR', 'DsTest', 'Patient')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.patient],
  );

  await pool.query(
    `INSERT INTO job_postings (id, case_number, patient_id, title, description, country, status)
     VALUES ($1, 99201, $2, 'ds-e2e-vacancy', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.vacancy, IDS.patient],
  );

  // Worker com WJA + histórico de outbox (2 registros — o teste prova que o
  // helper pega o MAIS RECENTE por created_at, não o primeiro/último inserido).
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country)
     VALUES ($1, 'ds-worker-uid', 'ds-worker-fixture@e2e.local', '+54911000097', 'REGISTERED', 'AR')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.worker],
  );

  await pool.query(
    `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, $3, 'INVITED', 'manual')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.wja, IDS.worker, IDS.vacancy],
  );

  // Registro mais antigo — se o helper pegasse o primeiro (sem ORDER BY
  // created_at DESC), este teste falharia.
  await pool.query(
    `INSERT INTO messaging_outbox
       (worker_id, job_posting_id, template_slug, status, delivery_status, twilio_sid, channel, created_at)
     VALUES ($1, $2, 'qualified_worker_request', 'sent', 'read', 'SM_DS_E2E_OLDER', 'twilio', NOW() - INTERVAL '1 hour')`,
    [IDS.worker, IDS.vacancy],
  );

  // Registro mais recente — o que a asserção espera.
  await pool.query(
    `INSERT INTO messaging_outbox
       (worker_id, job_posting_id, template_slug, status, delivery_status, twilio_sid, channel, created_at)
     VALUES ($1, $2, 'qualified_worker_request', 'sent', 'delivered', 'SM_DS_E2E_LATEST', 'twilio', NOW())`,
    [IDS.worker, IDS.vacancy],
  );

  // Worker sem WJA nenhuma nesta vaga — cobre o 404.
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country)
     VALUES ($1, 'ds-worker-nowja-uid', 'ds-worker-nowja@e2e.local', '+54911000096', 'REGISTERED', 'AR')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.workerNoWja],
  );
}

async function cleanFixtures(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM messaging_outbox WHERE worker_id IN ($1, $2)`,
    [IDS.worker, IDS.workerNoWja],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_job_applications WHERE id = $1`,
    [IDS.wja],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM job_postings WHERE id = $1`,
    [IDS.vacancy],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM workers WHERE id IN ($1, $2)`,
    [IDS.worker, IDS.workerNoWja],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM patients WHERE id = $1`,
    [IDS.patient],
  ).catch(() => {});
}
