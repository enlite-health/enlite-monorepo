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
 * API real + Postgres real. Nenhum side-effect outbound: `ActivateRecruitmentUseCase` só faz
 * SELECT…FOR UPDATE + INSERT em job_postings + UPDATE em patients — sem Twilio/WhatsApp/Periskope/
 * e-mail no caminho (grep confirmado, ver relatório da sessão). `USE_MOCK_AUTH=true` e
 * `TwilioVerifyService`/`PeriskopeNoteService` sobem "not configured" nesta stack (log do
 * container) — não há canal real para o teste tocar mesmo que algo tentasse.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'activation-e2e-%';
const HORARIO = '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]';

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
});
