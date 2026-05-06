/**
 * funnel-table.e2e.test.ts
 *
 * E2E tests for GET /api/admin/vacancies/:id/funnel-table
 *
 * Scenarios:
 *   1. Vacancy with no candidates → rows=[], all counts zero
 *   2. Vacancy with 5 workers in distinct stages:
 *        W1: INVITED stage, no WhatsApp dispatch      → INVITED bucket, NOT_SENT
 *        W2: INITIATED stage, WhatsApp DELIVERED       → POSTULATED bucket, DELIVERED
 *        W3: COMPLETED stage, WhatsApp READ            → POSTULATED bucket, READ
 *        W4: SELECTED stage, interview confirmed       → PRE_SELECTED bucket, REPLIED
 *        W5: REJECTED stage, interview declined        → WITHDREW bucket  (declined overrides bucket)
 *   3. ?bucket=INVITED filter → 1 row but counts still reflect all 5
 *   4. whatsapp_bulk_dispatch_logs with 2 dispatches for same worker → uses most recent
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Deterministic IDs (prefix fnt to avoid collision) ───────────────────────

const IDS = {
  patient:  'f7000001-0000-4000-a001-000000000001',
  jobEmpty: 'f7000001-0000-4000-a002-000000000001',
  jobFull:  'f7000001-0000-4000-a002-000000000002',
  w1: 'f7000001-0000-4000-a003-000000000001',
  w2: 'f7000001-0000-4000-a003-000000000002',
  w3: 'f7000001-0000-4000-a003-000000000003',
  w4: 'f7000001-0000-4000-a003-000000000004',
  w5: 'f7000001-0000-4000-a003-000000000005',
};

describe('GET /api/admin/vacancies/:id/funnel-table', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;

  // ── Setup ─────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid:   'fnt-admin-e2e',
      email: 'fnt-admin@e2e.local',
      role:  'admin',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
    await seedFixtures(pool);
  });

  afterAll(async () => {
    await cleanFixtures(pool);
    await pool.end();
  });

  function auth() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  // ── Scenario 1: empty vacancy ──────────────────────────────────────────────

  describe('Scenario 1: vacancy with no candidates', () => {
    it('returns rows=[] and all counts zero', async () => {
      const res = await api.get(`/api/admin/vacancies/${IDS.jobEmpty}/funnel-table`, auth());

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.rows).toHaveLength(0);
      expect(res.data.data.counts.ALL).toBe(0);
      expect(res.data.data.counts.INVITED).toBe(0);
      expect(res.data.data.counts.POSTULATED).toBe(0);
      expect(res.data.data.counts.PRE_SELECTED).toBe(0);
      expect(res.data.data.counts.REJECTED).toBe(0);
      expect(res.data.data.counts.WITHDREW).toBe(0);
    });
  });

  // ── Scenario 2: 5 workers in distinct stages ──────────────────────────────

  describe('Scenario 2: 5 workers in distinct stages', () => {
    it('returns 5 rows total and correct counts', async () => {
      const res = await api.get(`/api/admin/vacancies/${IDS.jobFull}/funnel-table`, auth());

      expect(res.status).toBe(200);
      const { rows, counts } = res.data.data;
      expect(counts.ALL).toBe(5);
      expect(rows).toHaveLength(5);
    });

    it('W1 (INVITED, no WhatsApp) → bucket INVITED, whatsappStatus NOT_SENT', async () => {
      const res = await api.get(`/api/admin/vacancies/${IDS.jobFull}/funnel-table`, auth());
      const row = (res.data.data.rows as any[]).find((r: any) => r.workerId === IDS.w1);

      expect(row).toBeDefined();
      expect(row.funnelStage).toBe('INVITED');
      expect(row.whatsappStatus).toBe('NOT_SENT');
      expect(row.accepted).toBeNull();
    });

    it('W2 (INITIATED, WhatsApp DELIVERED) → bucket POSTULATED, whatsappStatus DELIVERED', async () => {
      const res = await api.get(`/api/admin/vacancies/${IDS.jobFull}/funnel-table`, auth());
      const row = (res.data.data.rows as any[]).find((r: any) => r.workerId === IDS.w2);

      expect(row).toBeDefined();
      expect(row.funnelStage).toBe('INITIATED');
      expect(row.whatsappStatus).toBe('DELIVERED');
    });

    it('W3 (COMPLETED, WhatsApp READ) → whatsappStatus READ', async () => {
      const res = await api.get(`/api/admin/vacancies/${IDS.jobFull}/funnel-table`, auth());
      const row = (res.data.data.rows as any[]).find((r: any) => r.workerId === IDS.w3);

      expect(row).toBeDefined();
      expect(row.funnelStage).toBe('COMPLETED');
      expect(row.whatsappStatus).toBe('READ');
    });

    it('W4 (SELECTED, interview confirmed) → whatsappStatus REPLIED, accepted=true', async () => {
      const res = await api.get(`/api/admin/vacancies/${IDS.jobFull}/funnel-table`, auth());
      const row = (res.data.data.rows as any[]).find((r: any) => r.workerId === IDS.w4);

      expect(row).toBeDefined();
      expect(row.funnelStage).toBe('SELECTED');
      expect(row.whatsappStatus).toBe('REPLIED');
      expect(row.accepted).toBe(true);
      expect(row.interviewResponse).toBe('confirmed');
    });

    it('W5 (REJECTED, interview declined) → accepted=false, bucket WITHDREW', async () => {
      const res = await api.get(`/api/admin/vacancies/${IDS.jobFull}/funnel-table`, auth());
      const row = (res.data.data.rows as any[]).find((r: any) => r.workerId === IDS.w5);

      expect(row).toBeDefined();
      expect(row.funnelStage).toBe('REJECTED');
      expect(row.whatsappStatus).toBe('REPLIED');
      expect(row.accepted).toBe(false);
      expect(row.interviewResponse).toBe('declined');
    });

    it('counts split correctly across buckets', async () => {
      const res = await api.get(`/api/admin/vacancies/${IDS.jobFull}/funnel-table`, auth());
      const { counts } = res.data.data;

      // W1 → INVITED
      expect(counts.INVITED).toBe(1);
      // W2 (INITIATED) + W3 (COMPLETED) → POSTULATED
      expect(counts.POSTULATED).toBe(2);
      // W4 (SELECTED) → PRE_SELECTED
      expect(counts.PRE_SELECTED).toBe(1);
      // W5 (REJECTED + declined) → WITHDREW (declined takes precedence)
      expect(counts.WITHDREW).toBe(1);
      expect(counts.REJECTED).toBe(0);
      expect(counts.ALL).toBe(5);
    });
  });

  // ── Scenario 3: ?bucket filter ────────────────────────────────────────────

  describe('Scenario 3: bucket filter', () => {
    it('?bucket=INVITED returns only W1 but counts still reflect all 5', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.jobFull}/funnel-table?bucket=INVITED`,
        auth(),
      );

      expect(res.status).toBe(200);
      const { rows, counts } = res.data.data;
      expect(rows).toHaveLength(1);
      expect(rows[0].workerId).toBe(IDS.w1);
      // Counts MUST reflect full vacancy, not filtered rows
      expect(counts.ALL).toBe(5);
      expect(counts.INVITED).toBe(1);
      expect(counts.POSTULATED).toBe(2);
      expect(counts.PRE_SELECTED).toBe(1);
    });

    it('?bucket=POSTULATED returns 2 rows (W2 + W3)', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.jobFull}/funnel-table?bucket=POSTULATED`,
        auth(),
      );

      const workerIds = (res.data.data.rows as any[]).map((r: any) => r.workerId).sort();
      expect(workerIds).toHaveLength(2);
      expect(workerIds).toContain(IDS.w2);
      expect(workerIds).toContain(IDS.w3);
    });

    it('invalid bucket → 400', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.jobFull}/funnel-table?bucket=INVALID`,
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });
  });

  // ── Scenario 4: multiple dispatch logs — uses most recent ──────────────────

  describe('Scenario 4: multiple whatsapp_bulk_dispatch_logs for same worker', () => {
    it('uses the most recent dispatch log (READ overrides older SENT)', async () => {
      // W3 has 2 dispatch logs seeded: older=SENT, newer=READ → expect READ
      const res = await api.get(`/api/admin/vacancies/${IDS.jobFull}/funnel-table`, auth());
      const row = (res.data.data.rows as any[]).find((r: any) => r.workerId === IDS.w3);

      expect(row.whatsappStatus).toBe('READ');
    });
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function seedFixtures(pool: Pool): Promise<void> {
  await cleanFixtures(pool);

  // Patient (clickup_task_id is NOT NULL UNIQUE)
  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name)
     VALUES ($1, 'fnt-e2e-task-001', 'AR', 'FntTest', 'Patient')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.patient],
  );

  // Vacancy numbers (use sequence)
  const vnRes = await pool.query<{ vn: string }>(
    "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
  );
  const vn1 = parseInt(vnRes.rows[0].vn);
  const vnRes2 = await pool.query<{ vn: string }>(
    "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
  );
  const vn2 = parseInt(vnRes2.rows[0].vn);

  // Empty vacancy
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status)
     VALUES ($1, $2, 99001, $3, 'fnt-e2e-empty', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.jobEmpty, vn1, IDS.patient],
  );

  // Full vacancy (5 candidates)
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status)
     VALUES ($1, $2, 99002, $3, 'fnt-e2e-full', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.jobFull, vn2, IDS.patient],
  );

  // Workers (no encrypted fields — KMS returns null for null input)
  for (const [idx, wid] of [IDS.w1, IDS.w2, IDS.w3, IDS.w4, IDS.w5].entries()) {
    const authUid = `fnt-worker-${idx + 1}`;
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country)
       VALUES ($1, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [wid, authUid, `fnt-w${idx + 1}@e2e.local`, `+5491100000${idx + 1}0`],
    );
  }

  // worker_job_applications
  const wjaRows: Array<{
    wid: string;
    stage: string;
    ir: string | null;
  }> = [
    { wid: IDS.w1, stage: 'INVITED',   ir: null },
    { wid: IDS.w2, stage: 'INITIATED', ir: null },
    { wid: IDS.w3, stage: 'COMPLETED', ir: null },
    { wid: IDS.w4, stage: 'SELECTED',  ir: 'confirmed' },
    { wid: IDS.w5, stage: 'REJECTED',  ir: 'declined' },
  ];

  for (const row of wjaRows) {
    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, application_status, source, interview_response)
       VALUES ($1, $2, $3, 'applied', 'manual', $4)
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
         application_funnel_stage = EXCLUDED.application_funnel_stage,
         interview_response       = EXCLUDED.interview_response`,
      [row.wid, IDS.jobFull, row.stage, row.ir],
    );
  }

  // WhatsApp dispatch logs
  // W2: DELIVERED
  await pool.query(
    `INSERT INTO whatsapp_bulk_dispatch_logs
       (worker_id, triggered_by, phone, template_slug, status, delivery_status, dispatched_at)
     VALUES ($1, 'fnt-admin', '+5491100000020', 'test-tpl', 'sent', 'delivered', NOW() - INTERVAL '1 hour')`,
    [IDS.w2],
  );

  // W3: 2 dispatches — older=SENT (no delivery_status), newer=READ
  await pool.query(
    `INSERT INTO whatsapp_bulk_dispatch_logs
       (worker_id, triggered_by, phone, template_slug, status, delivery_status, dispatched_at)
     VALUES ($1, 'fnt-admin', '+5491100000030', 'test-tpl', 'sent', NULL, NOW() - INTERVAL '2 hours')`,
    [IDS.w3],
  );
  await pool.query(
    `INSERT INTO whatsapp_bulk_dispatch_logs
       (worker_id, triggered_by, phone, template_slug, status, delivery_status, dispatched_at)
     VALUES ($1, 'fnt-admin', '+5491100000030', 'test-tpl', 'sent', 'read', NOW() - INTERVAL '30 minutes')`,
    [IDS.w3],
  );

  // W4: dispatch exists (REPLIED override because confirmed)
  await pool.query(
    `INSERT INTO whatsapp_bulk_dispatch_logs
       (worker_id, triggered_by, phone, template_slug, status, delivery_status, dispatched_at)
     VALUES ($1, 'fnt-admin', '+5491100000040', 'test-tpl', 'sent', 'delivered', NOW() - INTERVAL '1 hour')`,
    [IDS.w4],
  );

  // W5: dispatch exists (REPLIED override because declined)
  await pool.query(
    `INSERT INTO whatsapp_bulk_dispatch_logs
       (worker_id, triggered_by, phone, template_slug, status, delivery_status, dispatched_at)
     VALUES ($1, 'fnt-admin', '+5491100000050', 'test-tpl', 'sent', 'delivered', NOW() - INTERVAL '1 hour')`,
    [IDS.w5],
  );
}

async function cleanFixtures(pool: Pool): Promise<void> {
  const workerIds = [IDS.w1, IDS.w2, IDS.w3, IDS.w4, IDS.w5];

  await pool.query(
    `DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id = ANY($1)`,
    [workerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_job_applications WHERE job_posting_id IN ($1, $2)`,
    [IDS.jobEmpty, IDS.jobFull],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM encuadres WHERE job_posting_id IN ($1, $2)`,
    [IDS.jobEmpty, IDS.jobFull],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM job_postings WHERE id IN ($1, $2)`,
    [IDS.jobEmpty, IDS.jobFull],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM workers WHERE id = ANY($1)`,
    [workerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM patients WHERE id = $1`,
    [IDS.patient],
  ).catch(() => {});
}
