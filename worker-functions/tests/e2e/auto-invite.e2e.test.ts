/**
 * auto-invite.e2e.test.ts
 *
 * Valida o Fluxo A de recrutamento automático (Fase 3):
 *   POST /api/admin/vacancies → domain_event 'vacancy.created' inserido
 *   → VacancyAutoInviteHandler enfileira messaging_outbox com template
 *     'vacancy_invited_auto' para cada AT compatível.
 *
 * Setup:
 *   - Cria paciente + endereço com lat/lng para habilitar geo-match
 *   - Cria worker REGISTERED com worker_service_areas na mesma região
 *   - Cria vaga via API (dispara domain_event no setImmediate)
 *
 * Asserts:
 *   - domain_events tem row com event='vacancy.created'
 *   - messaging_outbox tem row com job_posting_id + template_slug='vacancy_invited_auto'
 *   - Re-criar vaga com mesmo worker não duplica outbox (idempotência)
 *
 * Nota: O handler é processado via DomainEventProcessor.sweepPendingEvents
 * ou por Pub/Sub push. Em E2E local, aguarda o sweep automático (5 min safety net)
 * OU disparamos manualmente via POST /api/internal/events/sweep.
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

const CASE_NUMBER = 99991; // número reservado para este teste

async function waitForCondition(
  fn: () => Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

describe('Fluxo A — convite automático pós-criação de vaga', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let patientAddressId: string;
  let workerId: string;
  let vacancyId: string;

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'auto-invite-admin',
      email: 'auto-invite-admin@e2e.local',
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });

    // Limpar dados de testes anteriores (idempotente)
    await pool.query(`DELETE FROM messaging_outbox WHERE template_slug = 'vacancy_invited_auto'
      AND worker_id IN (SELECT id FROM workers WHERE email LIKE '%@autoinvite.e2e')`);
    await pool.query(`DELETE FROM domain_events WHERE event = 'vacancy.created'
      AND payload->>'jobPostingId' IN (
        SELECT id::text FROM job_postings WHERE case_number = $1
      )`, [CASE_NUMBER]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (
      SELECT id FROM job_postings WHERE case_number = $1
    )`, [CASE_NUMBER]);
    await pool.query(`DELETE FROM job_postings WHERE case_number = $1`, [CASE_NUMBER]);
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id IN (
      SELECT id FROM workers WHERE email LIKE '%@autoinvite.e2e'
    )`);
    await pool.query(`DELETE FROM workers WHERE email LIKE '%@autoinvite.e2e'`);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'e2e-autoinvite-%'`);

    // 1. Criar paciente
    patientId = await createPatientFixture(pool, 'autoinvite');

    // 2. Criar endereço do paciente com lat/lng (CABA, Buenos Aires)
    const addrRes = await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses
         (patient_id, address_type, city, neighborhood, address_formatted, lat, lng)
       VALUES ($1, 'primary', 'CABA', 'Palermo', 'Av Santa Fe 1234, CABA', -34.5874, -58.4079)
       RETURNING id`,
      [patientId],
    );
    patientAddressId = addrRes.rows[0].id;

    // Atualizar job_postings com lat/lng do endereço (service_lat/service_lng via patient_addresses)
    // Não é necessário setar direto: MatchmakingService lê via JOIN em job_postings.patient_address_id

    // 3. Criar worker REGISTERED com service area próxima (~3km de Palermo)
    const workerRes = await pool.query<{ id: string }>(
      `INSERT INTO workers
         (auth_uid, email, country, timezone, status, occupation)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED', 'AT')
       RETURNING id`,
      [`uid-autoinvite-${Date.now()}`, `worker-${Date.now()}@autoinvite.e2e`],
    );
    workerId = workerRes.rows[0].id;

    // worker_service_areas com lat/lng.
    // Nota: a coluna `location` é GENERATED ALWAYS AS (ST_MakePoint(lng, lat)) STORED —
    // não pode ser inserida diretamente; o banco a computa automaticamente.
    await pool.query(
      `INSERT INTO worker_service_areas
         (worker_id, latitude, longitude, radius_km, work_zone, address_line, deleted_at)
       VALUES ($1, -34.5700, -58.4200, 30, 'Palermo', 'Av Córdoba 2000, CABA', NULL)`,
      [workerId],
    );
  });

  afterAll(async () => {
    if (pool) {
      if (vacancyId) {
        await pool.query(`DELETE FROM messaging_outbox WHERE job_posting_id = $1`, [vacancyId]);
        await pool.query(`DELETE FROM domain_events WHERE payload->>'jobPostingId' = $1`, [vacancyId]);
        await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [vacancyId]);
        await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      }
      await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [workerId]);
      await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
      await pool.query(`DELETE FROM patient_addresses WHERE id = $1`, [patientAddressId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  it('domain_events recebe vacancy.created após POST /api/admin/vacancies', async () => {
    const res = await api.post(
      '/api/admin/vacancies',
      {
        case_number: CASE_NUMBER,
        patient_id: patientId,
        patient_address_id: patientAddressId,
        status: 'SEARCHING',
      },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
    vacancyId = res.data.data.id as string;

    // Aguarda setImmediate + INSERT async em domain_events
    await waitForCondition(async () => {
      const { rows } = await pool.query(
        `SELECT id FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1`,
        [vacancyId],
      );
      return rows.length > 0;
    }, 5000);

    const { rows } = await pool.query(
      `SELECT event, payload FROM domain_events WHERE payload->>'jobPostingId' = $1`,
      [vacancyId],
    );
    expect(rows[0].event).toBe('vacancy.created');
    expect(rows[0].payload.jobPostingId).toBe(vacancyId);
  });

  it('processa o domain_event via processEvent e enfileira messaging_outbox para worker compatível', async () => {
    // Busca o ID do domain_event inserido no teste anterior
    const evtRes = await pool.query<{ id: string }>(
      `SELECT id FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1 LIMIT 1`,
      [vacancyId],
    );
    expect(evtRes.rows.length).toBeGreaterThan(0);
    const eventId = evtRes.rows[0].id;

    // Dispara processamento direto do evento (sem aguardar o age gate do sweep)
    // Usa formato Pub/Sub push com base64 do payload
    const pubsubPayload = Buffer.from(JSON.stringify({ eventId })).toString('base64');
    const processRes = await api.post(
      '/api/internal/events/process',
      { message: { data: pubsubPayload } },
      { headers: { 'X-Internal-Secret': INTERNAL_SECRET } },
    );
    expect([200, 204]).toContain(processRes.status);

    // Aguarda o handler inserir na messaging_outbox
    await waitForCondition(async () => {
      const { rows } = await pool.query(
        `SELECT id FROM messaging_outbox
         WHERE job_posting_id = $1 AND template_slug = 'vacancy_invited_auto'`,
        [vacancyId],
      );
      return rows.length > 0;
    }, 8000);

    const { rows } = await pool.query(
      `SELECT worker_id, template_slug, status, variables
       FROM messaging_outbox
       WHERE job_posting_id = $1 AND template_slug = 'vacancy_invited_auto'`,
      [vacancyId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const row = rows[0];
    expect(row.template_slug).toBe('vacancy_invited_auto');
    expect(row.status).toBe('pending');

    // Variables devem conter worker_name como token (não plaintext)
    const vars = row.variables as Record<string, string>;
    expect(vars.worker_name).toMatch(/^tk_/);
    expect(vars.vacancy_case_number).toBe(String(CASE_NUMBER));
  });

  it('domain_event fica com status processed após o sweep', async () => {
    const { rows } = await pool.query(
      `SELECT status FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1`,
      [vacancyId],
    );
    expect(rows[0]?.status).toBe('processed');
  });

  it('re-processar o mesmo domain_event não duplica messaging_outbox (idempotência)', async () => {
    // Busca ID do evento (já foi marcado 'processed' no teste anterior — DomainEventProcessor ignora)
    const evtRes = await pool.query<{ id: string }>(
      `SELECT id FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1 LIMIT 1`,
      [vacancyId],
    );
    const eventId = evtRes.rows[0]?.id;

    if (eventId) {
      // Tentar reprocessar um evento já 'processed' — DomainEventProcessor retorna 'skipped'
      const pubsubPayload = Buffer.from(JSON.stringify({ eventId })).toString('base64');
      await api.post(
        '/api/internal/events/process',
        { message: { data: pubsubPayload } },
        { headers: { 'X-Internal-Secret': INTERNAL_SECRET } },
      );
    }
    await new Promise(r => setTimeout(r, 1500));

    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messaging_outbox
       WHERE job_posting_id = $1 AND template_slug = 'vacancy_invited_auto' AND worker_id = $2`,
      [vacancyId, workerId],
    );
    // Deve ter no máximo 1 linha por worker (dedup 7 dias)
    expect(Number(rows[0].cnt)).toBeLessThanOrEqual(1);
  });
});
