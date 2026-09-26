/**
 * worker-timeline.e2e.test.ts
 *
 * E2E tests for GET /api/admin/workers/:id/timeline
 *
 * Setup: creates a worker + status_history rows + job_application +
 *        application_stage_history + bulk_dispatch_logs via SQL directly.
 *
 * Scenarios:
 * 1. Returns 200 with data array ordered by occurred_at DESC
 * 2. Each event has the correct kind and required fields
 * 3. Pagination: limit=1 returns 1 item, total reflects actual count
 * 4. Returns 401 without auth token
 * 5. Returns 403 for worker role (staffOnly endpoint)
 * 6. Returns 400 for invalid UUID
 * 7. Returns empty data for worker with no events
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000001';

describe('GET /api/admin/workers/:id/timeline', () => {
  const api = createApiClient();
  let staffToken: string;
  let workerToken: string;
  let pool: Pool;
  let workerId: string;
  let applicationId: string;

  const suffix = Date.now();

  beforeAll(async () => {
    await waitForBackend(api);

    [staffToken, workerToken] = await Promise.all([
      getMockToken(api, {
        uid: `timeline-staff-${suffix}`,
        email: `timeline-staff-${suffix}@e2e.local`,
        role: 'recruiter',
      }),
      getMockToken(api, {
        uid: `timeline-worker-${suffix}`,
        email: `timeline-worker-${suffix}@e2e.local`,
        role: 'worker',
      }),
    ]);

    pool = new Pool({ connectionString: DATABASE_URL });

    // 1. Create worker
    const workerRes = await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone)
       VALUES ($1, $2, $3, 'REGISTERED', 'AR', 'America/Buenos_Aires')
       RETURNING id`,
      [
        `timeline-e2e-${suffix}`,
        `timeline-e2e-${suffix}@e2e.local`,
        `+549${suffix}`.slice(0, 15),
      ],
    );
    workerId = workerRes.rows[0].id as string;

    // 2. Insert status_history rows directly (trigger fires on UPDATE in real flow,
    //    but for E2E fixture we insert directly to avoid needing a real UPDATE path)
    await pool.query(
      `INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, changed_by)
       VALUES ($1, 'status', 'REGISTERED', 'AVAILABLE', 'e2e-admin')`,
      [workerId],
    );

    // 3. Create a job posting (required FK for job application)
    const patientRes = await pool.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'E2E', 'Timeline', 'AR', 'ACTIVE')
       RETURNING id`,
      [`timeline-clickup-${suffix}`],
    );
    const patientId = patientRes.rows[0].id as string;

    const jobRes = await pool.query(
      `INSERT INTO job_postings (patient_id, status, title, case_number, vacancy_number)
       VALUES ($1, 'ACTIVE', 'CASO 999-1', 999, 1)
       RETURNING id`,
      [patientId],
    );
    const jobPostingId = jobRes.rows[0].id as string;

    // 4. Create job application (trigger fires AFTER INSERT, inserts initial stage row)
    // PRE_SCREENING é o stage inicial canônico desde migration 230/264 (substituiu
    // INITIATED, removido do CHECK constraint em migration 264 / #95).
    const appRes = await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $2, 'PRE_SCREENING')
       RETURNING id`,
      [workerId, jobPostingId],
    );
    applicationId = appRes.rows[0].id as string;

    // 5. Additional stage transition for coverage (trigger fires AFTER UPDATE)
    await pool.query(
      `UPDATE worker_job_applications
       SET application_funnel_stage = 'QUALIFIED'
       WHERE id = $1`,
      [applicationId],
    );

    // 6. Insert bulk dispatch log
    await pool.query(
      `INSERT INTO whatsapp_bulk_dispatch_logs
         (worker_id, triggered_by, template_slug, status)
       VALUES ($1, 'scheduler', 'complete_register_ofc', 'sent')`,
      [workerId],
    );
  });

  afterAll(async () => {
    // Cleanup — cascade handles child rows
    if (workerId) {
      await pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
    }
    await pool.end();
  });

  describe('happy path', () => {
    it('returns 200 with data array', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
    });

    it('each event has required fields', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      expect(res.status).toBe(200);
      for (const event of res.data.data) {
        expect(['status_change', 'funnel_stage', 'whatsapp']).toContain(event.kind);
        expect(typeof event.id).toBe('string');
        expect(typeof event.label).toBe('string');
        expect(typeof event.new_value).toBe('string');
        expect(typeof event.occurred_at).toBe('string');
        // old_value, changed_by, application_id, template_slug can be null
      }
    });

    it('results are ordered by occurred_at DESC', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      expect(res.status).toBe(200);
      const dates = res.data.data.map((e: { occurred_at: string }) => new Date(e.occurred_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });

    it('total reflects actual event count', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      expect(res.status).toBe(200);
      expect(typeof res.data.total).toBe('number');
      expect(res.data.total).toBeGreaterThan(0);
      expect(res.data.total).toBeGreaterThanOrEqual(res.data.data.length);
    });

    it('pagination: limit=1 returns 1 item, total unchanged', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline?limit=1&offset=0`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      expect(res.status).toBe(200);
      expect(res.data.data).toHaveLength(1);
      expect(res.data.limit).toBe(1);
      expect(res.data.offset).toBe(0);
      // total should still reflect the full count, not just 1
      expect(res.data.total).toBeGreaterThan(0);
    });

    it('returns empty data for worker with no events', async () => {
      // Create a fresh worker with no events (different phone prefix to avoid unique collision)
      const freshRes = await pool.query(
        `INSERT INTO workers (auth_uid, email, phone, status, country, timezone)
         VALUES ($1, $2, $3, 'REGISTERED', 'AR', 'America/Buenos_Aires')
         RETURNING id`,
        [
          `timeline-empty-${suffix}`,
          `timeline-empty-${suffix}@e2e.local`,
          `+548${suffix}`.slice(0, 15),
        ],
      );
      const freshId = freshRes.rows[0].id as string;

      try {
        // Trigger fires on INSERT into worker_job_applications but we skip that here —
        // this worker has no status_history, no applications, no dispatch logs
        const res = await api.get(`/api/admin/workers/${freshId}/timeline`, {
          headers: { Authorization: `Bearer ${staffToken}` },
        });

        expect(res.status).toBe(200);
        // The trigger on worker_job_applications fires on INSERT, not on workers.
        // Status history requires an explicit INSERT/UPDATE cycle.
        expect(Array.isArray(res.data.data)).toBe(true);
        expect(res.data.total).toBe(0);
      } finally {
        await pool.query('DELETE FROM workers WHERE id = $1', [freshId]);
      }
    });

    it('funnel_stage events have application_id', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      const funnelEvents = res.data.data.filter((e: { kind: string }) => e.kind === 'funnel_stage');
      expect(funnelEvents.length).toBeGreaterThan(0);
      for (const ev of funnelEvents) {
        expect(ev.application_id).toBeTruthy();
      }
    });

    it('whatsapp events have template_slug', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      const waEvents = res.data.data.filter((e: { kind: string }) => e.kind === 'whatsapp');
      expect(waEvents.length).toBeGreaterThan(0);
      for (const ev of waEvents) {
        expect(ev.template_slug).toBe('complete_register_ofc');
      }
    });

    it('whatsapp events include source field populated', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      expect(res.status).toBe(200);
      const waEvents = res.data.data.filter((e: { kind: string }) => e.kind === 'whatsapp');
      expect(waEvents.length).toBeGreaterThan(0);
      for (const ev of waEvents) {
        // source must be one of the valid enum values; the fixture inserts without explicit source
        // so it defaults to 'bulk' from migration 172
        expect(['bulk', 'individual', 'outbox']).toContain(ev.source);
      }
    });

    it('non-whatsapp events have source=null', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      expect(res.status).toBe(200);
      const nonWaEvents = res.data.data.filter(
        (e: { kind: string }) => e.kind !== 'whatsapp',
      );
      for (const ev of nonWaEvents) {
        expect(ev.source).toBeNull();
      }
    });
  });

  describe('auth and validation', () => {
    it('returns 401 without auth token', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`);
      expect(res.status).toBe(401);
    });

    it('returns 403 for worker role', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${workerToken}` },
      });
      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid UUID', async () => {
      const res = await api.get('/api/admin/workers/not-a-uuid/timeline', {
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for limit=0', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline?limit=0`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      expect(res.status).toBe(400);
    });

    it('returns 200 for non-existent worker UUID (empty data, not 404)', async () => {
      // Endpoint doesn't verify worker exists — returns empty timeline
      const res = await api.get(`/api/admin/workers/${NON_EXISTENT_UUID}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      expect(res.status).toBe(200);
      expect(res.data.data).toHaveLength(0);
      expect(res.data.total).toBe(0);
    });
  });
});
