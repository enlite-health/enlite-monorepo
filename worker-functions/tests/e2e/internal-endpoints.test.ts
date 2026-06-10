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
});
