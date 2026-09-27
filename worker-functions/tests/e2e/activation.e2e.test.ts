/**
 * activation.e2e.test.ts @integration — spec 018, PR-6, ADR-5 (`contracts/activation.md`).
 *
 * Ativação de recrutamento é POR SERVIÇO (não mais um botão único no cabeçalho do paciente):
 *   - `POST /patients/:id/contracted-services` (JÁ EXISTE, spec 013 bloco C — só chamado aqui);
 *   - `POST /patients/:id/contracted-services/:sid/activate-recruitment` (novo, este PR): gate
 *     `RECRUITMENT_BLOCKING_CODES` (SERVICE_ADDRESS/SERVICE_SCHEDULE do serviço + COVERAGE do
 *     paciente), 1 vaga em rascunho (`is_draft`/status `PENDING_ACTIVATION`), paciente do funil
 *     PERMANECE no funil — quem move a SEARCHING é o lançamento à Talentum (D434), não este passo;
 *   - `POST /patients/:id/activate` (a rota antiga, de paciente inteiro) virou 410 `ACTIVATION_SPLIT`.
 *
 * API real + Postgres real. Nenhum side-effect outbound: `ActivateRecruitmentUseCase` só faz
 * SELECT…FOR UPDATE + INSERT em job_postings + UPDATE em patients — sem Twilio/WhatsApp/Periskope/
 * e-mail no caminho (grep confirmado, ver relatório da sessão). `USE_MOCK_AUTH=true` e
 * `TwilioVerifyService`/`PeriskopeNoteService` sobem "not configured" nesta stack (log do
 * container) — não há canal real para o teste tocar mesmo que algo tentasse.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'activation-e2e-%';
const HORARIO = '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]';

describe('Ativação de recrutamento por serviço (spec 018, PR-6) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: StaffAuth;
  // Hotfix gate-cobertura-verificada-vacante (28/09): provider PRÓPRIO deste arquivo, criado
  // INATIVO por SQL direto (o POST /catalogs/insurance-providers só cria active=true — mesma
  // convenção de patient-coverage-catalog.e2e.test.ts, mas aqui não há endpoint de baixa).
  // 'OSDE' (catálogo seed, migration 311) cobre o caso ATIVO — nenhum teste do repo o desativa.
  const COVERAGE_INACTIVE_CODE = `E2E_INA_${Date.now().toString(36).toUpperCase()}`;

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
    pool = new Pool({ connectionString: DATABASE_URL });
    // O uid precisa existir em `users` por causa da FK de `job_posting_audit_log.actor_user_id`
    // (mesma convenção de `vacancy-audit-log.e2e.test.ts`) — sem isto, `logEventSafe` (SAVEPOINT
    // best-effort) engole a violação de FK em silêncio e a linha do audit nunca é gravada.
    // Semeia DEPOIS de `staffAuth` resolver: com o emulador de pé, o uid EFETIVO é o
    // localId do emulador (`asAdmin.uid`), não o literal pedido — semear o literal faz a FK
    // aceitar um uid que ninguém apresenta, e a violação real (uid do token) é engolida em
    // silêncio pelo SAVEPOINT best-effort acima.
    asAdmin = await staffAuth('activation-e2e-admin', 'admin');
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (firebase_uid) DO NOTHING`,
      [asAdmin.uid, 'activation-e2e-admin@e2e.local', 'Activation E2E Admin'],
    );
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    // 305: patient_insurance_verified tem FK ON DELETE CASCADE de patients — some junto.
    // O provider é INDEPENDENTE do paciente (catálogo global), por isso limpo à parte.
    await pool.query(`DELETE FROM insurance_providers WHERE code = $1`, [COVERAGE_INACTIVE_CODE]);
    await pool.query(
      `INSERT INTO insurance_providers (code, active, retired_at, sort_order)
       SELECT $1, false, NOW(), COALESCE(MAX(sort_order), 0) + 1 FROM insurance_providers`,
      [COVERAGE_INACTIVE_CODE],
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    await pool.query(`DELETE FROM insurance_providers WHERE code = $1`, [COVERAGE_INACTIVE_CODE]);
    await pool.end();
  });

  it('FELIZ: paciente de funil sem serviço → cria serviço com endereço/horário/cobertura → activate-recruitment cria vaga em borrador e NÃO move o paciente — o lançamento move, D434', async () => {
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
    expect(r.data.data.patientStatus).toBe('PENDING_ADMISSION');
    expect(r.data.data.statusChanged).toBe(false);

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
    expect(patient.status).toBe('PENDING_ADMISSION');

    // spec 029 — achado: o botão "ativar recrutamento" gravava `job_posting_audit_log` com
    // `actor_type=SYSTEM`/`actor_user_id` NULO, mesmo com um operador humano (asAdmin) autenticado
    // clicando. Prova por IGUALDADE com o uid que `staffAuth` produziu de verdade — não só
    // "não nulo" — porque um `actor_user_id` de OUTRO uid também passaria num assert fraco.
    const { rows: [audit] } = await pool.query<{
      actor_user_id: string | null;
      actor_type: string;
      actor_label: string;
    }>(
      `SELECT actor_user_id, actor_type, actor_label FROM job_posting_audit_log
        WHERE job_posting_id = $1 AND event_type = 'CREATED'`,
      [r.data.data.vacancyId],
    );
    expect(audit).toBeDefined();
    expect(audit.actor_user_id).toBe(asAdmin.uid);
    expect(audit.actor_type).toBe('HUMAN');
    expect(audit.actor_label).toBe('activate_recruitment');
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

    // recusado → paciente continua no funil (como o caso feliz agora também continua: só o lançamento move a SEARCHING).
    const { rows: [patient] } = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`, [patientId],
    );
    expect(patient.status).toBe('PENDING_ADMISSION');
  });

  // Hotfix gate-cobertura-verificada-vacante (28/09): os 3 casos abaixo provam
  // `has_verified_active_coverage` (ActivateRecruitmentUseCase.ts:145 e
  // PatientDetailQueryHelper.ts:120) — SQL que, sem estes casos, nenhum teste executa contra
  // Postgres real (os unitários recebem o booleano já pronto via mock).

  it('ALTERNATIVO 3: só cobertura VERIFICADA (legado vazio, patient_insurance_verified com provider ativo) → activate-recruitment ACEITA', async () => {
    const patientId = await criarPacienteDeFunil({
      tag: 'activation-e2e-coverage-verified',
      caseNumber: 991004,
      coverage: null, // legado (health_insurance_name) fica AUSENTE de propósito: só a cobertura verificada sustenta o gate
    });

    const addr = await api.post(
      `/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Av. Cobertura Verificada 100', address_type: 'primary' },
      asAdmin,
    );
    const addressId = addr.data.data.id as string;
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: JSON.parse(HORARIO) },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;

    // 'OSDE' é do catálogo seed (migration 311), active=true — nenhum teste do repo o desativa.
    await pool.query(
      `INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, provider_code, source)
       VALUES ($1, 1, 'OSDE', 'OSDE', 'admin_manual')`,
      [patientId],
    );

    const r = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
      {},
      asAdmin,
    );
    expect(r.status).toBe(201);
    expect(r.data.success).toBe(true);
    expect(typeof r.data.data.vacancyId).toBe('string');

    const { rows: [vacancy] } = await pool.query<{ contracted_service_id: string }>(
      `SELECT contracted_service_id FROM job_postings WHERE id = $1`,
      [r.data.data.vacancyId],
    );
    expect(vacancy.contracted_service_id).toBe(serviceId);
  });

  it('ALTERNATIVO 4: sem cobertura nenhuma (legado vazio, nenhuma linha em patient_insurance_verified) → 422 com COVERAGE e não cria vaga', async () => {
    const patientId = await criarPacienteDeFunil({
      tag: 'activation-e2e-coverage-missing',
      caseNumber: 991005,
      coverage: null,
    });

    const addr = await api.post(
      `/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Av. Sin Cobertura 200', address_type: 'primary' },
      asAdmin,
    );
    const addressId = addr.data.data.id as string;
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: JSON.parse(HORARIO) },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;

    // De propósito: nenhuma linha em patient_insurance_verified para este paciente.
    const r = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
      {},
      asAdmin,
    );
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toContain('COVERAGE');
    expect(r.data.details.missing).not.toContain('SERVICE_ADDRESS');
    expect(r.data.details.missing).not.toContain('SERVICE_SCHEDULE');

    const { rows: [n] } = await pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [patientId],
    );
    expect(Number(n.n)).toBe(0);
  });

  it('ALTERNATIVO 5: cobertura verificada com provider INATIVO (AND ip.active) → 422 com COVERAGE — mata a cláusula sem ela', async () => {
    const patientId = await criarPacienteDeFunil({
      tag: 'activation-e2e-coverage-inactive-provider',
      caseNumber: 991006,
      coverage: null,
    });

    const addr = await api.post(
      `/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Av. Provider Inactivo 300', address_type: 'primary' },
      asAdmin,
    );
    const addressId = addr.data.data.id as string;
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: JSON.parse(HORARIO) },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;

    await pool.query(
      `INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, provider_code, source)
       VALUES ($1, 1, $2, $2, 'admin_manual')`,
      [patientId, COVERAGE_INACTIVE_CODE],
    );

    const r = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
      {},
      asAdmin,
    );
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toContain('COVERAGE');

    const { rows: [n] } = await pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [patientId],
    );
    expect(Number(n.n)).toBe(0);
  });
});
