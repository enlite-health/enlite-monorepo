/**
 * inbound-whatsapp.test.ts
 *
 * E2E para o webhook inbound WhatsApp (Step 7).
 * Testa o endpoint POST /api/webhooks/twilio/inbound que recebe
 * respostas de botões interativos do worker via Twilio.
 *
 * Setup:
 *   - Worker com phone no banco
 *   - Job posting com meet_link_1/meet_datetime_1
 *   - worker_job_applications com interview_response='pending'
 *   - messaging_outbox com twilio_sid para correlação
 *
 * O ambiente E2E não tem TWILIO_INBOUND_WEBHOOK_URL, então
 * a validação de assinatura é pulada automaticamente.
 */

import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const WORKER_PHONE = '+5491199880001';
const WORKER_EMAIL = 'inbound-e2e@test.local';
const FUTURE_DATETIME = '2099-07-15T14:00:00Z';
const MEET_LINK = 'https://meet.google.com/inbound-e2e-test';

describe('Inbound WhatsApp Webhook — Step 7', () => {
  const api = createApiClient();
  let pool: Pool;
  let workerId: string;
  let jobPostingId: string;
  let outboxTwilioSid: string;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    // 1. Criar worker
    const workerRes = await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, status, created_at, updated_at)
       VALUES ('inbound-e2e-uid', $1, $2, 'REGISTERED', NOW(), NOW())
       ON CONFLICT (auth_uid) DO UPDATE SET email = EXCLUDED.email, phone = EXCLUDED.phone
       RETURNING id`,
      [WORKER_EMAIL, WORKER_PHONE],
    );
    workerId = workerRes.rows[0].id;

    // 2. Criar job_posting com meet links
    const jpRes = await pool.query(
      `INSERT INTO job_postings (case_number, title, meet_link_1, meet_datetime_1, status, created_at, updated_at)
       VALUES (99901, 'Vaga Inbound E2E', $1, $2, 'SEARCHING', NOW(), NOW())
       RETURNING id`,
      [MEET_LINK, FUTURE_DATETIME],
    );
    jobPostingId = jpRes.rows[0].id;

    // 3. Criar worker_job_application com interview_response='pending'
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, interview_response, created_at, updated_at)
       VALUES ($1, $2, 'QUALIFIED', 'pending', NOW(), NOW())
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE
         SET interview_response = 'pending', interview_meet_link = NULL, updated_at = NOW()`,
      [workerId, jobPostingId],
    );

    // 4. Inserir registro na outbox com twilio_sid para correlação
    outboxTwilioSid = 'SM_INBOUND_E2E_' + Date.now();
    await pool.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, twilio_sid, attempts)
       VALUES ($1, 'qualified_worker', $2::jsonb, 'sent', $3, 1)`,
      [
        workerId,
        JSON.stringify({ job_posting_id: jobPostingId }),
        outboxTwilioSid,
      ],
    );

    // 5. Inserir templates necessários
    await pool.query(`
      INSERT INTO message_templates (slug, name, body, is_active, created_at, updated_at) VALUES
        ('qualified_worker_request', 'Worker Qualificado — Convite Entrevista', '{{slot_1}}{{slot_2}}{{slot_3}}{{case_number}}', true, NOW(), NOW()),
        ('qualified_worker', 'Worker Qualificado (legacy)', '{{slot_1}}{{slot_2}}{{slot_3}}{{case_number}}', true, NOW(), NOW()),
        ('qualified_worker_response', 'Worker Qualificado — Confirmação Entrevista', '{{date}}{{time}}', true, NOW(), NOW()),
        ('qualified_reminder_confirm', 'Confirmación 24h', 'Hola {{name}}! Mañana {{date}} a las {{time}}. ¿Confirma?', true, NOW(), NOW()),
        ('qualified_declined_admin', 'Worker declinó', 'Worker {{name}} (ID: {{worker_id}}) declinó.', true, NOW(), NOW())
      ON CONFLICT (slug) DO NOTHING
    `);
  });

  afterAll(async () => {
    // Cleanup
    await pool.query('DELETE FROM messaging_outbox WHERE worker_id = $1', [workerId]);
    await pool.query('DELETE FROM worker_job_applications WHERE worker_id = $1', [workerId]);
    await pool.query('DELETE FROM job_postings WHERE id = $1', [jobPostingId]);
    await pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
    await pool.end();
  });

  // ─── Botão de convite antigo: a reserva automática saiu (spec 052, Fase 4) ──

  it('slot_1 de convite antigo → 200, e NADA é reservado nem enfileirado', async () => {
    const res = await api.post('/api/webhooks/twilio/inbound', new URLSearchParams({
      From: `whatsapp:${WORKER_PHONE}`,
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: outboxTwilioSid,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT application_funnel_stage, interview_meet_link, interview_datetime, interview_response
       FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, jobPostingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('QUALIFIED');
    expect(rows[0].interview_meet_link).toBeNull();
    expect(rows[0].interview_datetime).toBeNull();
    expect(rows[0].interview_response).toBe('pending');

    const { rows: outbox } = await pool.query(
      `SELECT template_slug FROM messaging_outbox
       WHERE worker_id = $1 AND template_slug = 'qualified_worker_response'`,
      [workerId],
    );
    expect(outbox).toHaveLength(0);
  });

  // ─── No ButtonPayload → ignored ────────────────────────────────────

  it('ignores messages without ButtonPayload', async () => {
    const res = await api.post('/api/webhooks/twilio/inbound', new URLSearchParams({
      From: `whatsapp:${WORKER_PHONE}`,
      Body: 'Hola, tengo una consulta',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);
  });

  // ─── Unknown worker → 200 (no crash) ───────────────────────────────

  it('returns 200 for unknown phone (no crash)', async () => {
    const res = await api.post('/api/webhooks/twilio/inbound', new URLSearchParams({
      From: 'whatsapp:+5491100000000',
      ButtonPayload: 'slot_1',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    // Always returns 200 to avoid Twilio retries
    expect(res.status).toBe(200);
  });

  // ─── Non-interview template → ignored ─���────────────────────────────

  it('ignores button responses from non-interview templates', async () => {
    // Insert outbox with different template
    const otherSid = 'SM_OTHER_TEMPLATE_' + Date.now();
    await pool.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, twilio_sid, attempts)
       VALUES ($1, 'complete_register_ofc', '{}'::jsonb, 'sent', $2, 1)`,
      [workerId, otherSid],
    );

    const res = await api.post('/api/webhooks/twilio/inbound', new URLSearchParams({
      From: `whatsapp:${WORKER_PHONE}`,
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: otherSid,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(200);
  });
});
