/**
 * activation.e2e.test.ts @integration — spec 018, PR-6, ADR-5 (`contracts/activation.md`).
 *
 * Ativação de recrutamento é POR SERVIÇO (não mais um botão único no cabeçalho do paciente):
 *   - `POST /patients/:id/contracted-services` (JÁ EXISTE, spec 013 bloco C — só chamado aqui);
 *   - `POST /patients/:id/contracted-services/:sid/activate-recruitment` (novo, este PR): gate
 *     `RECRUITMENT_BLOCKING_CODES` (SERVICE_ADDRESS/SERVICE_SCHEDULE do serviço + COVERAGE do
 *     paciente), 1 vaga em rascunho (`is_draft`/status `PENDING_ACTIVATION`), paciente do funil
 *     vai para SEARCHING;
 *   - `POST /patients/:id/activate` (a rota antiga, de paciente inteiro) virou 410 `ACTIVATION_SPLIT`.
 *
 * API real + Postgres real. `ActivateRecruitmentUseCase` faz SELECT…FOR UPDATE + INSERT em
 * job_postings + UPDATE em patients dentro da transação — sem Twilio/WhatsApp/Periskope/e-mail
 * NESSA parte (grep confirmado). `USE_MOCK_AUTH=true` e `TwilioVerifyService`/`PeriskopeNoteService`
 * sobem "not configured" nesta stack (log do container) — não há canal real pra tocar mesmo que
 * algo tentasse.
 *
 * T040/T041 (spec 027, Fase 4) — pós-commit (setImmediate, fora da transação acima), o use case
 * agora ENFILEIRA `vacancy.created` em `domain_events`. O describe abaixo ("T043") é quem liga as
 * duas pontas: activate-recruitment → domain_events → (processado via `/api/internal/events/process`,
 * igual ao molde de `auto-invite.e2e.test.ts`) → `messaging_outbox`. O `CloudTasksClient` que viria
 * depois do outbox (`schedule()`) é mock nesta stack (`NODE_ENV=test`, ver `CloudTasksClient.ts:24`)
 * — nunca sai HTTP real daqui.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'activation-e2e-%';
const HORARIO = '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

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

describe('Ativação de recrutamento por serviço (spec 018, PR-6) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: { headers: { Authorization: string } };

  async function criarPacienteDeFunil(opts: {
    tag: string;
    coverage?: string | null;
    caseNumber?: number;
  }): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number, health_insurance_name)
       VALUES ($1, 'Activation', 'E2E', 'AR', 'PENDING_ADMISSION', $2, $3) RETURNING id`,
      [opts.tag, opts.caseNumber ?? null, opts.coverage ?? null],
    )).rows[0].id;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('activation-e2e-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    await pool.end();
  });

  it('FELIZ: paciente de funil sem serviço → cria serviço com endereço/horário/cobertura → activate-recruitment cria vaga em borrador e move o paciente a SEARCHING', async () => {
    const patientId = await criarPacienteDeFunil({ tag: 'activation-e2e-happy', caseNumber: 991001 });

    // endereço do paciente (SERVICE_ADDRESS exige um patient_addresses vivo, referenciado pelo serviço)
    const addr = await api.post(
      `/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Av. Siempre Viva 742', address_type: 'primary' },
      asAdmin,
    );
    expect(addr.status).toBe(201);
    const addressId = addr.data.data.id as string;

    // serviço contratado: endpoint JÁ EXISTENTE (spec 013 bloco C) — não reimplementado aqui.
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: JSON.parse(HORARIO) },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;

    // COVERAGE: "Particular" é resposta EXPLÍCITA válida (FR-121/122) — grava depois da criação
    // do paciente para não acoplar este teste ao shape do INSERT de patients acima.
    await pool.query(`UPDATE patients SET health_insurance_name = 'Particular' WHERE id = $1`, [patientId]);

    const before = await pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [patientId],
    );
    expect(Number(before.rows[0].n)).toBe(0);

    const r = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
      {},
      asAdmin,
    );
    expect(r.status).toBe(201);
    expect(r.data.success).toBe(true);
    expect(typeof r.data.data.vacancyId).toBe('string');
    expect(r.data.data.patientStatus).toBe('SEARCHING');
    expect(r.data.data.statusChanged).toBe(true);

    const { rows: [vacancy] } = await pool.query<{ status: string; is_draft: boolean; contracted_service_id: string }>(
      `SELECT status, is_draft, contracted_service_id FROM job_postings WHERE id = $1`,
      [r.data.data.vacancyId],
    );
    expect(vacancy.contracted_service_id).toBe(serviceId);
    expect(vacancy.status).toBe('PENDING_ACTIVATION');
    expect(vacancy.is_draft).toBe(true);

    const { rows: [patient] } = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`, [patientId],
    );
    expect(patient.status).toBe('SEARCHING');
  });

  it('ALTERNATIVO 1: POST /patients/:id/activate (rota antiga, paciente inteiro) → 410 Gone', async () => {
    const patientId = await criarPacienteDeFunil({ tag: 'activation-e2e-alt1', caseNumber: 991002 });

    const r = await api.post(`/api/admin/patients/${patientId}/activate`, {}, asAdmin);
    expect(r.status).toBe(410);
    expect(r.data.code).toBe('ACTIVATION_SPLIT');

    const { rows: [patient] } = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`, [patientId],
    );
    expect(patient.status).toBe('PENDING_ADMISSION');
  });

  it('ALTERNATIVO 2: serviço sem horário (RECRUITMENT_BLOCKING_CODES: SERVICE_SCHEDULE) → activate-recruitment recusa 422 e não cria vaga', async () => {
    const patientId = await criarPacienteDeFunil({
      tag: 'activation-e2e-alt2',
      caseNumber: 991003,
      coverage: 'Particular',
    });

    const addr = await api.post(
      `/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Calle Sin Horario 123', address_type: 'primary' },
      asAdmin,
    );
    const addressId = addr.data.data.id as string;

    // Mesmo endereço e cobertura do caso feliz — só falta o horário do serviço, de propósito.
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;

    const r = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
      {},
      asAdmin,
    );
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toContain('SERVICE_SCHEDULE');
    expect(r.data.details.missing).not.toContain('SERVICE_ADDRESS');
    expect(r.data.details.missing).not.toContain('COVERAGE');

    const { rows: [n] } = await pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [patientId],
    );
    expect(Number(n.n)).toBe(0);

    // recusado → paciente continua no funil, sem mudar para SEARCHING.
    const { rows: [patient] } = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`, [patientId],
    );
    expect(patient.status).toBe('PENDING_ADMISSION');
  });

  // ── T043 (spec 027, Fase 4) — o buraco que esta task fecha: NENHUM teste, até
  // aqui, parte de activate-recruitment pra provar domain_events → messaging_outbox.
  // `tests/e2e/auto-invite.e2e.test.ts:167` é o molde do processamento (POST
  // /api/internal/events/process), mas ele sempre parte de POST /api/admin/vacancies.
  describe('T043 — activate-recruitment liga domain_events (vacancy.created) → messaging_outbox', () => {
    const WORKER_EMAIL_TAG = '@t043-activation.e2e';
    let workerId: string;

    beforeAll(async () => {
      await pool.query(
        `DELETE FROM worker_service_areas WHERE worker_id IN (SELECT id FROM workers WHERE email LIKE $1)`,
        [`%${WORKER_EMAIL_TAG}`],
      );
      await pool.query(`DELETE FROM workers WHERE email LIKE $1`, [`%${WORKER_EMAIL_TAG}`]);

      const w = await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country, timezone, status, occupation)
         VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED', 'AT')
         RETURNING id`,
        [`uid-t043-${Date.now()}`, `worker-t043-${Date.now()}${WORKER_EMAIL_TAG}`],
      );
      workerId = w.rows[0].id;
      // Mesma zona (CABA/Palermo, ~3km) do molde em auto-invite.e2e.test.ts.
      await pool.query(
        `INSERT INTO worker_service_areas
           (worker_id, latitude, longitude, radius_km, work_zone, address_line, deleted_at)
         VALUES ($1, -34.5700, -58.4200, 30, 'Palermo', 'Av Córdoba 2000, CABA', NULL)`,
        [workerId],
      );
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM messaging_outbox WHERE worker_id = $1`, [workerId]);
      await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = $1`, [workerId]);
      await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [workerId]);
      await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
    });

    it('POST activate-recruitment → domain_events(vacancy.created) → /api/internal/events/process → messaging_outbox', async () => {
      const patientId = await criarPacienteDeFunil({
        tag: 'activation-e2e-t043',
        caseNumber: 991900,
        coverage: 'Particular',
      });

      // Endereço com lat/lng (CABA/Palermo) via SQL direto — SEM passar pelo
      // endpoint /addresses (que geocoda via Google Maps de verdade; ver
      // `docs/funcionalidades/.../custo-google-maps`). A gate SERVICE_ADDRESS só
      // exige a linha existir com archived_at NULL; quem precisa de lat/lng de
      // verdade é o MatchmakingService (geo-busca), não a rota de criação.
      const addrRes = await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, city, neighborhood, address_formatted, lat, lng)
         VALUES ($1, 'CABA', 'Palermo', 'Av Santa Fe 1234, CABA', -34.5874, -58.4079)
         RETURNING id`,
        [patientId],
      );
      const addressId = addrRes.rows[0].id;

      const svc = await api.post(
        `/api/admin/patients/${patientId}/contracted-services`,
        { serviceCode: 'AT', addressId, schedule: JSON.parse(HORARIO) },
        asAdmin,
      );
      expect(svc.status).toBe(201);
      const serviceId = svc.data.data.id as string;

      const r = await api.post(
        `/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
        {},
        asAdmin,
      );
      expect(r.status).toBe(201);
      const vacancyId = r.data.data.vacancyId as string;

      // 1. domain_events recebe vacancy.created — INSERT feito no setImmediate
      //    pós-commit (T040), fora da transação de activate-recruitment.
      await waitForCondition(async () => {
        const { rows } = await pool.query(
          `SELECT id FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1`,
          [vacancyId],
        );
        return rows.length > 0;
      }, 5000);

      const evtRes = await pool.query<{ id: string; payload: { jobPostingId: string } }>(
        `SELECT id, payload FROM domain_events WHERE event = 'vacancy.created' AND payload->>'jobPostingId' = $1 LIMIT 1`,
        [vacancyId],
      );
      expect(evtRes.rows[0].payload.jobPostingId).toBe(vacancyId);
      const eventId = evtRes.rows[0].id;

      // 2. Processa o evento (Pub/Sub push simulado, mesmo formato do molde
      //    auto-invite.e2e.test.ts) — dispara VacancyAutoInviteHandler.
      const pubsubPayload = Buffer.from(JSON.stringify({ eventId })).toString('base64');
      const processRes = await api.post(
        '/api/internal/events/process',
        { message: { data: pubsubPayload } },
        { headers: { 'X-Internal-Secret': INTERNAL_SECRET } },
      );
      expect([200, 204]).toContain(processRes.status);

      // 3. messaging_outbox recebe o convite pro worker REGISTERED da zona.
      await waitForCondition(async () => {
        const { rows } = await pool.query(
          `SELECT id FROM messaging_outbox WHERE job_posting_id = $1 AND worker_id = $2`,
          [vacancyId, workerId],
        );
        return rows.length > 0;
      }, 8000);

      const { rows } = await pool.query(
        `SELECT template_slug, status FROM messaging_outbox WHERE job_posting_id = $1 AND worker_id = $2`,
        [vacancyId, workerId],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].template_slug).toBe('ar_vacancy_match_complete');
      expect(rows[0].status).toBe('pending');
    });
  });
});
