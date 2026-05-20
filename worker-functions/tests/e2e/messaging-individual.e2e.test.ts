/**
 * messaging-individual.e2e.test.ts
 *
 * E2E tests for Fase 2 of sprint/recruitment-automation:
 * - POST /api/admin/messaging/whatsapp inserts whatsapp_bulk_dispatch_logs
 *   with source='individual' when messaging succeeds
 * - The worker-timeline endpoint exposes that row with source populated
 *
 * Note: the test environment does NOT have Twilio configured, so the messaging
 * endpoint returns 502 (Twilio not configured). The log INSERT only fires on
 * success. This E2E test therefore validates the DB schema (migration 172),
 * the constraint, and the timeline exposure by inserting a log row directly.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Fase 2 — whatsapp_bulk_dispatch_logs source column + timeline', () => {
  const api = createApiClient();
  let staffToken: string;
  let pool: Pool;
  let workerId: string;

  const suffix = Date.now();

  beforeAll(async () => {
    await waitForBackend(api);

    staffToken = await getMockToken(api, {
      uid: `ind-msg-staff-${suffix}`,
      email: `ind-msg-staff-${suffix}@e2e.local`,
      role: 'recruiter',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Create worker
    const workerRes = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone)
       VALUES ($1, $2, $3, 'REGISTERED', 'BR', 'America/Sao_Paulo')
       RETURNING id`,
      [
        `ind-msg-e2e-${suffix}`,
        `ind-msg-e2e-${suffix}@e2e.local`,
        `+551${suffix}`.slice(0, 14),
      ],
    );
    workerId = workerRes.rows[0].id;
  });

  afterAll(async () => {
    if (workerId) {
      await pool.query('DELETE FROM workers WHERE id = $1', [workerId]).catch(() => {});
    }
    await pool.end();
  });

  describe('migration 172 — source column and constraint', () => {
    it('accepts source="individual" on INSERT', async () => {
      await expect(
        pool.query(
          `INSERT INTO whatsapp_bulk_dispatch_logs
             (worker_id, triggered_by, phone, template_slug, status, source)
           VALUES ($1, 'admin:test-user', $2, 'talent_search_welcome', 'sent', 'individual')`,
          [workerId, `+551${suffix}`.slice(0, 14)],
        ),
      ).resolves.toBeDefined();
    });

    it('accepts source="outbox" on INSERT', async () => {
      await expect(
        pool.query(
          `INSERT INTO whatsapp_bulk_dispatch_logs
             (worker_id, triggered_by, phone, template_slug, status, source)
           VALUES ($1, 'system:outbox:some-id', $2, 'talent_search_welcome', 'sent', 'outbox')`,
          [workerId, `+551${suffix}`.slice(0, 14)],
        ),
      ).resolves.toBeDefined();
    });

    it('accepts source="bulk" (default) on INSERT without explicit source', async () => {
      await expect(
        pool.query(
          `INSERT INTO whatsapp_bulk_dispatch_logs
             (worker_id, triggered_by, phone, template_slug, status)
           VALUES ($1, 'admin:test-bulk', $2, 'talent_search_welcome', 'sent')`,
          [workerId, `+551${suffix}`.slice(0, 14)],
        ),
      ).resolves.toBeDefined();

      // Verify default value was applied
      const check = await pool.query<{ source: string }>(
        `SELECT source FROM whatsapp_bulk_dispatch_logs
         WHERE worker_id = $1 AND triggered_by = 'admin:test-bulk'
         LIMIT 1`,
        [workerId],
      );
      expect(check.rows[0].source).toBe('bulk');
    });

    it('rejects invalid source value (constraint violation)', async () => {
      await expect(
        pool.query(
          `INSERT INTO whatsapp_bulk_dispatch_logs
             (worker_id, triggered_by, phone, template_slug, status, source)
           VALUES ($1, 'admin:test', $2, 'talent_search_welcome', 'sent', 'invalid_source')`,
          [workerId, `+551${suffix}`.slice(0, 14)],
        ),
      ).rejects.toThrow();
    });
  });

  describe('timeline endpoint exposes source field for whatsapp events', () => {
    it('returns source populated on whatsapp events', async () => {
      const res = await api.get(`/api/admin/workers/${workerId}/timeline`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const waEvents = res.data.data.filter(
        (e: { kind: string }) => e.kind === 'whatsapp',
      );

      // We inserted logs in this suite, so there should be at least some
      expect(waEvents.length).toBeGreaterThan(0);

      for (const ev of waEvents) {
        expect(ev).toHaveProperty('source');
        // source must be one of the valid enum values (or null for pre-migration rows with DEFAULT)
        if (ev.source !== null) {
          expect(['bulk', 'individual', 'outbox']).toContain(ev.source);
        }
      }
    });

    it('non-whatsapp events return source=null', async () => {
      // Insert a status_history row to ensure we have mixed kinds
      await pool.query(
        `INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, changed_by)
         VALUES ($1, 'status', 'REGISTERED', 'AVAILABLE', 'e2e-fase2')`,
        [workerId],
      );

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

  describe('POST /api/admin/messaging/whatsapp/direct — 502 without Twilio, no log written', () => {
    it('returns 502 (Twilio not configured) and log count is unchanged', async () => {
      const before = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM whatsapp_bulk_dispatch_logs
         WHERE worker_id = $1 AND triggered_by LIKE 'admin:%' AND source = 'individual'`,
        [workerId],
      );
      const countBefore = parseInt(before.rows[0].count, 10);

      const res = await api.post(
        '/api/admin/messaging/whatsapp/direct',
        { to: '+5511987654321', templateSlug: 'talent_search_welcome' },
        { headers: { Authorization: `Bearer ${staffToken}` } },
      );

      // 502 = Twilio not configured in test env; log INSERT only fires on success
      expect(res.status).toBe(502);

      const after = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM whatsapp_bulk_dispatch_logs
         WHERE worker_id = $1 AND triggered_by LIKE 'admin:%' AND source = 'individual'`,
        [workerId],
      );
      const countAfter = parseInt(after.rows[0].count, 10);

      // Count must NOT increase — no log on 502
      expect(countAfter).toBe(countBefore);
    });
  });
});
