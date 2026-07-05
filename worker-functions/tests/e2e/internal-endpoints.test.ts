import axios, { AxiosError } from 'axios';
import { Pool } from 'pg';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

const internalApi = axios.create({
  baseURL: `${API_URL}/api/internal`,
  headers: { 'X-Internal-Secret': INTERNAL_SECRET },
});

describe('Internal Endpoints (Pub/Sub + Cloud Tasks)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  // ─── Auth ────────────────────────────────────────────────────────────

  it('returns 403 without auth', async () => {
    try {
      await axios.post(`${API_URL}/api/internal/events/process`, {});
      fail('Expected 403');
    } catch (err) {
      const e = err as AxiosError;
      expect(e.response?.status).toBe(403);
    }
  });

  it('allows request with valid X-Internal-Secret', async () => {
    // Sends empty Pub/Sub body — should return 400 (missing eventId), not 403
    const res = await internalApi.post('/events/process', {}).catch(e => e.response);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Missing eventId');
  });

  // ─── Vertex AI smoke probe (post-deploy gate) ───────────────────────
  // Auth gate só (determinístico). O sucesso/falha do pingVertex é coberto no
  // unit test vertex-health.test.ts — não exercitamos a chamada real aqui pra
  // não depender de ADC/metadata server no container de CI.

  it('vertex-health returns 403 without auth', async () => {
    try {
      await axios.get(`${API_URL}/api/internal/vertex-health`);
      fail('Expected 403');
    } catch (err) {
      const e = err as AxiosError;
      expect(e.response?.status).toBe(403);
    }
  });

  // ─── Domain Events ──────────────────────────────────────────────────

  it('processes a domain event end-to-end', async () => {
    // Insert a test domain event
    const { rows } = await pool.query(
      `INSERT INTO domain_events (event, payload, status)
       VALUES ('test.event', $1, 'pending')
       RETURNING id`,
      [JSON.stringify({ testKey: 'testValue' })],
    );
    const eventId = rows[0].id;

    // Simulate Pub/Sub push message format
    const pubsubBody = {
      message: {
        data: Buffer.from(JSON.stringify({ eventId })).toString('base64'),
        messageId: 'test-msg-1',
      },
      subscription: 'projects/test/subscriptions/test',
    };

    const res = await internalApi.post('/events/process', pubsubBody);
    expect(res.status).toBe(200);
    // No handler registered for 'test.event' → status should be 'failed'
    expect(res.data.status).toBe('failed');

    // Verify the event was marked in DB
    const { rows: updated } = await pool.query(
      `SELECT status, error FROM domain_events WHERE id = $1`,
      [eventId],
    );
    expect(updated[0].status).toBe('failed');
    expect(updated[0].error).toContain('No handler');

    // Cleanup
    await pool.query('DELETE FROM domain_events WHERE id = $1', [eventId]);
  });

  // ─── Reminders ──────────────────────────────────────────────────────

  it('qualified reminder returns 200 with valid body', async () => {
    const res = await internalApi.post('/reminders/qualified', {
      workerId: '00000000-0000-0000-0000-000000000001',
      jobPostingId: '00000000-0000-0000-0000-000000000002',
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
  });

  it('qualified reminder returns 400 without body', async () => {
    const res = await internalApi.post('/reminders/qualified', {}).catch(e => e.response);
    expect(res.status).toBe(400);
  });

  // ─── Sweep & Bulk Dispatch ──────────────────────────────────────────
  // Os endpoints /outbox/sweep, /events/sweep e /bulk-dispatch/process
  // permanecem no código para uso manual em incidentes, mas não têm
  // trigger automático (Cloud Scheduler foi eliminado).
  //
  // Futuramente bulk-dispatch será reativado com Cloud Tasks (~1x/semana).

  // ─── Sweep Safe (allowlist safety net: mirror + registration_completed) ──

  describe('POST /events/sweep-safe', () => {
    it('returns 403 without auth', async () => {
      try {
        await axios.post(`${API_URL}/api/internal/events/sweep-safe`, {});
        fail('Expected 403');
      } catch (err) {
        const e = err as AxiosError;
        expect(e.response?.status).toBe(403);
      }
    });

    it('returns 200 with {deleted, processed, total} scoped to worker.mirror_requested only (legacy shape check)', async () => {
      const otherEventName = `test.sweep-safe.other.${Date.now()}`;
      const { rows } = await pool.query(
        `INSERT INTO domain_events (event, payload, status, created_at)
         VALUES ($1, '{}'::jsonb, 'pending', NOW() - INTERVAL '10 minutes')
         RETURNING id`,
        [otherEventName],
      );
      const otherEventId = rows[0].id;

      try {
        const res = await internalApi.post('/events/sweep-safe', {});

        expect(res.status).toBe(200);
        expect(typeof res.data.deleted).toBe('number');
        expect(typeof res.data.processed).toBe('number');
        expect(typeof res.data.total).toBe('number');

        // A pending event of a type OUTSIDE the allowlist must stay untouched.
        const { rows: untouched } = await pool.query(
          `SELECT status FROM domain_events WHERE id = $1`,
          [otherEventId],
        );
        expect(untouched[0].status).toBe('pending');
      } finally {
        await pool.query('DELETE FROM domain_events WHERE id = $1', [otherEventId]);
      }
    });

    it('processes BOTH allowlist events (mirror + registration_completed) and leaves vacancy.created untouched', async () => {
      const suffix = Date.now();
      const workerId = '00000000-0000-0000-0000-000000000099';

      const insertPending = async (event: string) => {
        const { rows } = await pool.query(
          `INSERT INTO domain_events (event, payload, status, created_at)
           VALUES ($1, $2, 'pending', NOW() - INTERVAL '10 minutes')
           RETURNING id`,
          [event, JSON.stringify({ workerId })],
        );
        return rows[0].id as string;
      };

      const mirrorEventId = await insertPending('worker.mirror_requested');
      const registrationEventId = await insertPending('worker.registration_completed');
      const vacancyEventId = await insertPending(`vacancy.created.e2e-guard.${suffix}`); // never real vacancy.created in this test to avoid side effects

      // Also cover the REAL vacancy.created name explicitly, to prove the allowlist
      // (not just event-name-prefix luck) is what protects it.
      const { rows: realVacancyRows } = await pool.query(
        `INSERT INTO domain_events (event, payload, status, created_at)
         VALUES ('vacancy.created', '{}'::jsonb, 'pending', NOW() - INTERVAL '10 minutes')
         RETURNING id`,
      );
      const realVacancyEventId = realVacancyRows[0].id as string;

      try {
        const res = await internalApi.post('/events/sweep-safe', {});

        expect(res.status).toBe(200);
        expect(res.data.byEvent['worker.mirror_requested']).toBeDefined();
        expect(res.data.byEvent['worker.registration_completed']).toBeDefined();
        // Both allowlist entries must have been SELECTED for sweeping (in-scope).
        expect(res.data.byEvent['worker.mirror_requested'].total).toBeGreaterThanOrEqual(1);
        expect(res.data.byEvent['worker.registration_completed'].total).toBeGreaterThanOrEqual(1);
        // registration_completed has no external dependency — proves real success.
        expect(res.data.byEvent['worker.registration_completed'].processed).toBeGreaterThanOrEqual(1);

        const { rows: statuses } = await pool.query(
          `SELECT id, status FROM domain_events WHERE id = ANY($1::uuid[])`,
          [[mirrorEventId, registrationEventId, vacancyEventId, realVacancyEventId]],
        );
        const byId = new Map(statuses.map((r: { id: string; status: string }) => [r.id, r.status]));

        // Mirror event was ATTEMPTED (no longer pending) — outcome (processed/failed)
        // depends on AnaCare/ADC reachability in this sandbox, which is out of scope
        // for the sweep-safe logic itself (already proven in isolation with a real
        // DB + fake handler in domain-event-mirror-sweep.integration.test.ts).
        expect(byId.get(mirrorEventId)).not.toBe('pending');
        expect(byId.get(registrationEventId)).toBe('processed');
        // Outside the allowlist — untouched regardless of naming resemblance.
        expect(byId.get(vacancyEventId)).toBe('pending');
        expect(byId.get(realVacancyEventId)).toBe('pending');
      } finally {
        await pool.query('DELETE FROM domain_events WHERE id = ANY($1::uuid[])', [
          [mirrorEventId, registrationEventId, vacancyEventId, realVacancyEventId],
        ]);
      }
    });

    it('returns 400 for an invalid query param', async () => {
      const res = await internalApi
        .post('/events/sweep-safe', {}, { params: { olderThanMinutes: 'not-a-number' } })
        .catch(e => e.response);
      expect(res.status).toBe(400);
    });
  });

  // ─── Events Health (backlog diagnostic) ─────────────────────────────

  describe('GET /events/health', () => {
    it('returns 403 without auth', async () => {
      try {
        await axios.get(`${API_URL}/api/internal/events/health`);
        fail('Expected 403');
      } catch (err) {
        const e = err as AxiosError;
        expect(e.response?.status).toBe(403);
      }
    });

    it('reports a stuck event group and returns 200 with summary/stuckCount', async () => {
      const eventName = `test.events-health.stuck.${Date.now()}`;
      const { rows } = await pool.query(
        `INSERT INTO domain_events (event, payload, status, created_at)
         VALUES ($1, '{}'::jsonb, 'pending', NOW() - INTERVAL '30 minutes')
         RETURNING id`,
        [eventName],
      );
      const eventId = rows[0].id;

      try {
        const res = await internalApi.get('/events/health', {
          params: { recentWindowHours: 6, stuckThresholdMinutes: 15 },
        });

        expect(res.status).toBe(200);
        expect(res.data.stuckCount).toBeGreaterThanOrEqual(1);

        const row = res.data.summary.find((r: { event: string }) => r.event === eventName);
        expect(row).toBeDefined();
        expect(row.stuck).toBe(true);
        expect(row.pendingRecent).toBe(1);
        expect(row.oldestRecentAgeMinutes).toBeGreaterThanOrEqual(29);
      } finally {
        await pool.query('DELETE FROM domain_events WHERE id = $1', [eventId]);
      }
    });

    it('returns 400 for an invalid query param', async () => {
      const res = await internalApi
        .get('/events/health', { params: { recentWindowHours: 'not-a-number' } })
        .catch(e => e.response);
      expect(res.status).toBe(400);
    });
  });
});
