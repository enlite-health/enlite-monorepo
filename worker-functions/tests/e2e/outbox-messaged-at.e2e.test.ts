/**
 * outbox-messaged-at.e2e.test.ts — D200.9
 *
 * Prova, contra Postgres REAL e API REAL (Docker), que o convite AUTOMÁTICO
 * (messaging_outbox → OutboxProcessor) carimba `messaged_at` na candidatura,
 * como o envio manual já fazia. Sem isto o card do Kanban dizia "Sin envíos"
 * depois do auto-invite — e, desde a D200.1, com o "Reenviar" travado.
 *
 * O fornecedor de WhatsApp é dublado NA FRONTEIRA: o worker usa o canal
 * Periskope e a API aponta para o stub local (host.docker.internal:9911,
 * docker-compose.test.yml). Mensagem real nunca sai daqui.
 *
 * Roda com a stack de pé: `npm run test:e2e -- outbox-messaged-at`.
 */
import http from 'http';
import { Pool } from 'pg';
import { createApiClient, createPatientFixture, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const STUB_PORT = Number(process.env.PERISKOPE_STUB_PORT ?? 9911);
const CASE_NUMBER = 99975; // reservado para este teste
const SLUG = 'ar_vacancy_match_complete';

function startSendStub(): { server: http.Server; calls: string[] } {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.endsWith('/message/send')) {
        calls.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'queued', unique_id: `stub-${calls.length}`, queue_id: 'q-1' }));
        return;
      }
      res.writeHead(405); res.end();
    });
  });
  server.listen(STUB_PORT, '0.0.0.0');
  return { server, calls };
}

describe('D200.9 — auto-invite (outbox) grava messaged_at na candidatura', () => {
  const api = createApiClient();
  let pool: Pool;
  let stub: ReturnType<typeof startSendStub>;
  let patientId = '';
  let addressId = '';
  let vacancyId = '';
  let workerId = '';
  let outboxId = '';

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    stub = startSendStub();

    await pool.query(
      `INSERT INTO message_templates (slug, name, body, category, is_active)
       VALUES ($1, 'E2E match completo', 'Hola {{worker_name}}, hay una vacante para vos.', 'vacancy', true)
       ON CONFLICT (slug) DO UPDATE SET is_active = true`,
      [SLUG],
    );
    patientId = await createPatientFixture(pool, 'outbox-messaged-at');
    const addr = await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_type, city, neighborhood, address_formatted, lat, lng)
       VALUES ($1, 'primary', 'CABA', 'Palermo', 'Av Santa Fe 1234, CABA', -34.5874, -58.4079) RETURNING id`,
      [patientId],
    );
    addressId = addr.rows[0].id;
    const jp = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (vacancy_number, case_number, title, description, patient_id, patient_address_id,
         required_professions, providers_needed, status, is_draft, country, created_at, updated_at)
       VALUES (nextval('job_postings_vacancy_number_seq'), $1, 'CASO e2e outbox', '', $2, $3,
         ARRAY['AT']::varchar[], 1, 'SEARCHING', false, 'AR', NOW(), NOW()) RETURNING id`,
      [CASE_NUMBER, patientId, addressId],
    );
    vacancyId = jp.rows[0].id;
    const uniq = Date.now();
    const w = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, occupation, messaging_channel,
         first_name_encrypted, last_name_encrypted, created_at, updated_at)
       VALUES ($1, $2, $3, 'REGISTERED', 'AR', 'AT', 'periskope', $4, $5, NOW(), NOW()) RETURNING id`,
      [`e2e-outbox-${uniq}`, `e2e.outbox.${uniq}@test.local`, `+549117${String(uniq).slice(-7)}`,
        Buffer.from('Prestador').toString('base64'), Buffer.from('Outbox').toString('base64')],
    );
    workerId = w.rows[0].id;
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, created_at, updated_at)
       VALUES ($1, $2, 'INVITED', 'system', NOW(), NOW())`,
      [workerId, vacancyId],
    );
    const ob = await pool.query<{ id: string }>(
      `INSERT INTO messaging_outbox (worker_id, job_posting_id, template_slug, variables, status)
       VALUES ($1, $2, $3, $4::jsonb, 'pending') RETURNING id`,
      [workerId, vacancyId, SLUG, JSON.stringify({ worker_name: 'Prestador' })],
    );
    outboxId = ob.rows[0].id;
  });

  afterAll(async () => {
    await new Promise<void>((r) => stub.server.close(() => r()));
    if (pool) {
      await pool.query(`DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id = $1`, [workerId]);
      await pool.query(`DELETE FROM messaging_outbox WHERE id = $1`, [outboxId]);
      await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = $1`, [workerId]);
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
      await pool.query(`DELETE FROM patient_addresses WHERE id = $1`, [addressId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  it('antes: candidatura sem messaged_at', async () => {
    const r = await pool.query<{ ok: boolean }>(
      `SELECT messaged_at IS NULL AS ok FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, vacancyId],
    );
    expect(r.rows[0].ok).toBe(true);
  });

  it('processar o outbox envia pelo stub e carimba messaged_at (+ log source=outbox)', async () => {
    const res = await api.post('/api/internal/outbox/process-paced', { outboxId }, { headers: { 'X-Internal-Secret': INTERNAL_SECRET } });
    expect(res.status).toBe(200);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toContain('vacante');

    const ob = await pool.query<{ status: string }>(`SELECT status FROM messaging_outbox WHERE id = $1`, [outboxId]);
    expect(ob.rows[0].status).toBe('sent');

    const wja = await pool.query<{ ok: boolean }>(
      `SELECT messaged_at IS NOT NULL AND messaged_at > NOW() - INTERVAL '1 minute' AS ok
       FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, vacancyId],
    );
    expect(wja.rows[0].ok).toBe(true);

    const log = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM whatsapp_bulk_dispatch_logs
       WHERE worker_id = $1 AND job_posting_id = $2 AND status = 'sent' AND source = 'outbox'`,
      [workerId, vacancyId],
    );
    expect(log.rows[0].n).toBe(1);
  });
});
