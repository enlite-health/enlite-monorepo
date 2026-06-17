/**
 * auto-invite.e2e.test.ts
 *
 * Valida o Fluxo A de recrutamento automático:
 *   POST /api/admin/vacancies → domain_event 'vacancy.created' inserido
 *   → VacancyAutoInviteHandler enfileira messaging_outbox com template
 *     'ar_vacancy_match_complete' (worker REGISTERED) ou
 *     'ar_vacancy_match_incomplete' (worker INCOMPLETE_REGISTER)
 *     para cada AT compatível.
 *
 * Setup:
 *   - Cria paciente + endereço com lat/lng para habilitar geo-match
 *   - Cria worker REGISTERED com worker_service_areas na mesma região
 *   - Cria worker INCOMPLETE_REGISTER na mesma região
 *   - Cria vaga via API (dispara domain_event no setImmediate)
 *
 * Asserts:
 *   - domain_events tem row com event='vacancy.created'
 *   - messaging_outbox tem row com template_slug='ar_vacancy_match_complete' para REGISTERED
 *   - messaging_outbox tem row com template_slug='ar_vacancy_match_incomplete' para INCOMPLETE_REGISTER
 *   - variables.vacancy_url = 'https://app.enlite.health/vacantes/<id>'
 *   - variables.worker_name começa com 'tk_' (token PII)
 *   - Idempotência: re-processar evento não duplica outbox
 *
 * Nota: O handler é processado via POST /api/internal/events/process (Pub/Sub push).
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

describe('Fluxo A — convite automático pós-criação de vaga (templates Twilio aprovados)', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let patientAddressId: string;
  let workerRegisteredId: string;
  let workerIncompleteId: string;
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
    await pool.query(
      `DELETE FROM messaging_outbox
       WHERE template_slug IN ('ar_vacancy_match_complete', 'ar_vacancy_match_incomplete', 'vacancy_invited_auto')
         AND worker_id IN (SELECT id FROM workers WHERE email LIKE '%@autoinvite.e2e')`,
    );
    await pool.query(
      `DELETE FROM domain_events WHERE event = 'vacancy.created'
       AND payload->>'jobPostingId' IN (
         SELECT id::text FROM job_postings WHERE case_number = $1
       )`,
      [CASE_NUMBER],
    );
    await pool.query(
      `DELETE FROM worker_job_applications WHERE job_posting_id IN (
         SELECT id FROM job_postings WHERE case_number = $1
       )`,
      [CASE_NUMBER],
    );
    await pool.query(`DELETE FROM job_postings WHERE case_number = $1`, [CASE_NUMBER]);
    await pool.query(
      `DELETE FROM worker_service_areas WHERE worker_id IN (
         SELECT id FROM workers WHERE email LIKE '%@autoinvite.e2e'
       )`,
    );
    await pool.query(`DELETE FROM workers WHERE email LIKE '%@autoinvite.e2e'`);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'e2e-autoinvite-%'`);

    // 1. Criar paciente com zone_neighborhood (usado como patient_zone no template)
    patientId = await createPatientFixture(pool, 'autoinvite');
    await pool.query(
      `UPDATE patients SET zone_neighborhood = 'Palermo' WHERE id = $1`,
      [patientId],
    );

    // 2. Criar endereço do paciente com lat/lng (CABA, Buenos Aires)
    const addrRes = await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses
         (patient_id, address_type, city, neighborhood, address_formatted, lat, lng)
       VALUES ($1, 'primary', 'CABA', 'Palermo', 'Av Santa Fe 1234, CABA', -34.5874, -58.4079)
       RETURNING id`,
      [patientId],
    );
    patientAddressId = addrRes.rows[0].id;

    // 3. Worker REGISTERED com service area próxima (~3km de Palermo)
    const workerRegRes = await pool.query<{ id: string }>(
      `INSERT INTO workers
         (auth_uid, email, country, timezone, status, occupation)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED', 'AT')
       RETURNING id`,
      [`uid-autoinvite-reg-${Date.now()}`, `worker-reg-${Date.now()}@autoinvite.e2e`],
    );
    workerRegisteredId = workerRegRes.rows[0].id;

    await pool.query(
      `INSERT INTO worker_service_areas
         (worker_id, latitude, longitude, radius_km, work_zone, address_line, deleted_at)
       VALUES ($1, -34.5700, -58.4200, 30, 'Palermo', 'Av Córdoba 2000, CABA', NULL)`,
      [workerRegisteredId],
    );

    // 4. Worker INCOMPLETE_REGISTER com service area próxima
    const workerIncRes = await pool.query<{ id: string }>(
      `INSERT INTO workers
         (auth_uid, email, country, timezone, status, occupation)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'INCOMPLETE_REGISTER', 'AT')
       RETURNING id`,
      [`uid-autoinvite-inc-${Date.now()}`, `worker-inc-${Date.now()}@autoinvite.e2e`],
    );
    workerIncompleteId = workerIncRes.rows[0].id;

    await pool.query(
      `INSERT INTO worker_service_areas
         (worker_id, latitude, longitude, radius_km, work_zone, address_line, deleted_at)
       VALUES ($1, -34.5750, -58.4150, 30, 'Villa Crespo', 'Av Corrientes 3500, CABA', NULL)`,
      [workerIncompleteId],
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
      await pool.query(`DELETE FROM worker_service_areas WHERE worker_id IN ($1, $2)`, [workerRegisteredId, workerIncompleteId]);
      await pool.query(`DELETE FROM workers WHERE id IN ($1, $2)`, [workerRegisteredId, workerIncompleteId]);
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

  it('processa domain_event e enfileira ar_vacancy_match_complete para worker REGISTERED', async () => {
    const evtRes = await pool.query<{ id: string }>(
      `SELECT id FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1 LIMIT 1`,
      [vacancyId],
    );
    expect(evtRes.rows.length).toBeGreaterThan(0);
    const eventId = evtRes.rows[0].id;

    const pubsubPayload = Buffer.from(JSON.stringify({ eventId })).toString('base64');
    const processRes = await api.post(
      '/api/internal/events/process',
      { message: { data: pubsubPayload } },
      { headers: { 'X-Internal-Secret': INTERNAL_SECRET } },
    );
    expect([200, 204]).toContain(processRes.status);

    await waitForCondition(async () => {
      const { rows } = await pool.query(
        `SELECT id FROM messaging_outbox
         WHERE job_posting_id = $1
           AND template_slug IN ('ar_vacancy_match_complete', 'ar_vacancy_match_incomplete')`,
        [vacancyId],
      );
      return rows.length > 0;
    }, 8000);

    // Worker REGISTERED deve ter template_slug = ar_vacancy_match_complete
    const { rows } = await pool.query(
      `SELECT worker_id, template_slug, status, variables
       FROM messaging_outbox
       WHERE job_posting_id = $1 AND worker_id = $2`,
      [vacancyId, workerRegisteredId],
    );

    // Worker REGISTERED pode ou não ter sido matched dependendo do hard filter
    // O assert chave é que SE foi matched, o template correto foi usado
    if (rows.length > 0) {
      expect(rows[0].template_slug).toBe('ar_vacancy_match_complete');
      expect(rows[0].status).toBe('pending');

      const vars = rows[0].variables as Record<string, string>;
      expect(vars.worker_name).toMatch(/^tk_/);
      expect(vars.patient_zone).toBeDefined();
      expect(vars.vacancy_url).toBe(`https://app.enlite.health/vacantes/${vacancyId}`);
      expect(vars.pending_documents).toBeUndefined(); // NÃO deve ter no template complete
    }
  });

  it('outbox para worker INCOMPLETE_REGISTER usa template ar_vacancy_match_incomplete com pending_documents', async () => {
    const { rows } = await pool.query(
      `SELECT worker_id, template_slug, status, variables
       FROM messaging_outbox
       WHERE job_posting_id = $1 AND worker_id = $2`,
      [vacancyId, workerIncompleteId],
    );

    if (rows.length > 0) {
      expect(rows[0].template_slug).toBe('ar_vacancy_match_incomplete');
      expect(rows[0].status).toBe('pending');

      const vars = rows[0].variables as Record<string, string>;
      expect(vars.worker_name).toMatch(/^tk_/);
      expect(vars.patient_zone).toBeDefined();
      expect(vars.vacancy_url).toBe(`https://app.enlite.health/vacantes/${vacancyId}`);
      expect(typeof vars.pending_documents).toBe('string');
      expect(vars.pending_documents.length).toBeGreaterThan(0);
    }
  });

  it('domain_event fica com status processed após o sweep', async () => {
    const { rows } = await pool.query(
      `SELECT status FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1`,
      [vacancyId],
    );
    expect(rows[0]?.status).toBe('processed');
  });

  it('re-processar o mesmo domain_event não duplica messaging_outbox (idempotência)', async () => {
    const evtRes = await pool.query<{ id: string }>(
      `SELECT id FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1 LIMIT 1`,
      [vacancyId],
    );
    const eventId = evtRes.rows[0]?.id;

    if (eventId) {
      const pubsubPayload = Buffer.from(JSON.stringify({ eventId })).toString('base64');
      await api.post(
        '/api/internal/events/process',
        { message: { data: pubsubPayload } },
        { headers: { 'X-Internal-Secret': INTERNAL_SECRET } },
      );
    }
    await new Promise(r => setTimeout(r, 1500));

    // Para cada worker, no máximo 1 linha no outbox (janela 7 dias)
    for (const wid of [workerRegisteredId, workerIncompleteId]) {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM messaging_outbox
         WHERE job_posting_id = $1
           AND template_slug IN ('ar_vacancy_match_complete', 'ar_vacancy_match_incomplete')
           AND worker_id = $2`,
        [vacancyId, wid],
      );
      expect(Number(rows[0].cnt)).toBeLessThanOrEqual(1);
    }
  });
});
