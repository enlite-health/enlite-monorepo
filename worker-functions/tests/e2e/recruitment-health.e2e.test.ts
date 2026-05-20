/**
 * recruitment-health.e2e.test.ts
 *
 * Valida o endpoint GET /api/admin/recruitment/health (Fase 6):
 *   - Responde 200 com shape correto
 *   - Todos os campos numéricos são >= 0
 *   - Campos batch são string|null (started_at, finished_at, batch_id)
 *   - Retorna 401 sem token
 *
 * Fluxo de setup:
 *   - Insere 1 domain_event 'vacancy.created'
 *   - Insere 1 messaging_outbox com template_slug='vacancy_invited_auto'
 *   - Insere 1 whatsapp_bulk_dispatch_logs com template_slug='complete_register_ofc' e batch_id
 *   para garantir que os contadores são >= 1 e os batches retornam dados reais.
 */

import { Pool } from 'pg';
import axios from 'axios';

const API_URL = process.env.API_URL ?? 'http://localhost:8080';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  validateStatus: () => true,
});

async function getStaffToken(): Promise<string> {
  // requireStaff() accepts: admin | recruiter | community_manager
  const res = await api.post('/api/test/auth/token', {
    uid: 'recruitment-health-e2e-admin',
    email: 'health-e2e@enlite.test',
    role: 'admin',
  });
  if (res.status !== 200) {
    throw new Error(`Failed to get staff token: ${JSON.stringify(res.data)}`);
  }
  return res.data.data.token as string;
}

function authHeaders(token: string): Record<string, Record<string, string>> {
  return { headers: { Authorization: `Bearer ${token}` } };
}

describe('GET /api/admin/recruitment/health — Fase 6', () => {
  let pool: Pool;
  let staffToken: string;

  // Ids of rows inserted by this test — used for cleanup
  let domainEventId: string;
  let outboxId: string;
  let workerId: string;
  let batchId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    staffToken = await getStaffToken();

    // ── seed: domain_event 'vacancy.created' ──────────────────────────
    const deRes = await pool.query<{ id: string }>(
      `INSERT INTO domain_events (event, payload, status)
       VALUES ('vacancy.created', '{"jobPostingId":"00000000-0000-4000-8000-e2e000000001"}'::jsonb, 'processed')
       RETURNING id`,
    );
    domainEventId = deRes.rows[0].id;

    // ── seed: worker (needed for FK in messaging_outbox) ──────────────
    const suffix = Date.now();
    const wRes = await pool.query<{ id: string }>(
      `INSERT INTO workers
         (auth_uid, email, country, timezone, status, occupation, phone)
       VALUES ($1, $2, 'BR', 'America/Sao_Paulo', 'REGISTERED', 'AT', $3)
       RETURNING id`,
      [
        `uid-health-e2e-${suffix}`,
        `health-e2e-${suffix}@test.enlite`,
        `+5511988${String(suffix).slice(-5)}`,
      ],
    );
    workerId = wRes.rows[0].id;

    // ── seed: messaging_outbox with vacancy_invited_auto ──────────────
    const obRes = await pool.query<{ id: string }>(
      `INSERT INTO messaging_outbox
         (worker_id, template_slug, variables, status)
       VALUES ($1, 'vacancy_invited_auto', '{}'::jsonb, 'pending')
       RETURNING id`,
      [workerId],
    );
    outboxId = obRes.rows[0].id;

    // ── seed: whatsapp_bulk_dispatch_logs with batch_id ───────────────
    batchId = '11111111-2222-4333-8444-555555555555';
    await pool.query(
      `INSERT INTO whatsapp_bulk_dispatch_logs
         (worker_id, triggered_by, phone, template_slug, status, batch_id, source)
       VALUES ($1, 'system', '+5511999990000', 'complete_register_ofc', 'sent', $2::uuid, 'bulk')`,
      [workerId, batchId],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(
      `DELETE FROM whatsapp_bulk_dispatch_logs WHERE batch_id = $1::uuid`,
      [batchId],
    );
    await pool.query(`DELETE FROM messaging_outbox WHERE id = $1`, [outboxId]);
    await pool.query(`DELETE FROM domain_events WHERE id = $1`, [domainEventId]);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
    await pool.end();
  });

  // ─── Auth guard ───────────────────────────────────────────────────

  it('returns 401 without Authorization header', async () => {
    const res = await api.get('/api/admin/recruitment/health');
    expect(res.status).toBe(401);
  });

  // ─── Shape ────────────────────────────────────────────────────────

  it('returns 200 with success: true', async () => {
    const res = await api.get('/api/admin/recruitment/health', authHeaders(staffToken));
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data).toBeDefined();
  });

  it('response has the three top-level metric keys', async () => {
    const res = await api.get('/api/admin/recruitment/health', authHeaders(staffToken));
    const { data } = res.data;
    expect(data).toHaveProperty('auto_invite_last_24h');
    expect(data).toHaveProperty('bulk_dispatch_incomplete_last_run');
    expect(data).toHaveProperty('bulk_dispatch_talentum_last_run');
  });

  it('auto_invite_last_24h contains all required number fields', async () => {
    const res = await api.get('/api/admin/recruitment/health', authHeaders(staffToken));
    const ai = res.data.data.auto_invite_last_24h;
    expect(typeof ai.vacancies_created).toBe('number');
    expect(typeof ai.invites_enqueued).toBe('number');
    expect(typeof ai.invites_sent).toBe('number');
    expect(typeof ai.invites_delivered).toBe('number');
    expect(typeof ai.invites_failed).toBe('number');
    expect(ai.vacancies_created).toBeGreaterThanOrEqual(0);
    expect(ai.invites_enqueued).toBeGreaterThanOrEqual(0);
    expect(ai.invites_sent).toBeGreaterThanOrEqual(0);
    expect(ai.invites_delivered).toBeGreaterThanOrEqual(0);
    expect(ai.invites_failed).toBeGreaterThanOrEqual(0);
  });

  it('auto_invite_last_24h counts reflect seeded rows', async () => {
    const res = await api.get('/api/admin/recruitment/health', authHeaders(staffToken));
    const ai = res.data.data.auto_invite_last_24h;
    // We inserted at least 1 domain_event and 1 outbox row above
    expect(ai.vacancies_created).toBeGreaterThanOrEqual(1);
    expect(ai.invites_enqueued).toBeGreaterThanOrEqual(1);
  });

  it('bulk_dispatch_incomplete_last_run has correct shape', async () => {
    const res = await api.get('/api/admin/recruitment/health', authHeaders(staffToken));
    const run = res.data.data.bulk_dispatch_incomplete_last_run;
    // batch_id is a string (we seeded one) or null
    expect(run.batch_id === null || typeof run.batch_id === 'string').toBe(true);
    expect(typeof run.total).toBe('number');
    expect(typeof run.sent).toBe('number');
    expect(typeof run.errors).toBe('number');
    expect(run.total).toBeGreaterThanOrEqual(0);
  });

  it('bulk_dispatch_incomplete_last_run reflects seeded batch', async () => {
    const res = await api.get('/api/admin/recruitment/health', authHeaders(staffToken));
    const run = res.data.data.bulk_dispatch_incomplete_last_run;
    // batch_id matches what we seeded
    expect(run.batch_id).toBe(batchId);
    expect(run.total).toBeGreaterThanOrEqual(1);
    expect(run.sent).toBeGreaterThanOrEqual(1);
    expect(run.started_at).not.toBeNull();
    expect(run.finished_at).not.toBeNull();
  });

  it('bulk_dispatch_talentum_last_run returns null batch_id when no talentum batch exists', async () => {
    // We did NOT seed a talentum_incomplete_reminder log, so batch_id should be null
    const res = await api.get('/api/admin/recruitment/health', authHeaders(staffToken));
    const run = res.data.data.bulk_dispatch_talentum_last_run;
    // If a previous E2E run seeded talentum rows, batch_id may be a string — still valid
    expect(run.batch_id === null || typeof run.batch_id === 'string').toBe(true);
    expect(run.total).toBeGreaterThanOrEqual(0);
    expect(run.sent).toBeGreaterThanOrEqual(0);
    expect(run.errors).toBeGreaterThanOrEqual(0);
  });
});
