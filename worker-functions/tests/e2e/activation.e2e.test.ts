/**
 * activation.e2e.test.ts @integration — spec 018, PR-6, ADR-5 (`contracts/activation.md`).
 *
 * Ativação de recrutamento é POR SERVIÇO (não mais um botão único no cabeçalho do paciente):
 *   - `POST /patients/:id/contracted-services` (JÁ EXISTE, spec 013 bloco C — só chamado aqui);
 *   - `POST /patients/:id/contracted-services/:sid/activate-recruitment` (novo, este PR): gate
 *     `RECRUITMENT_BLOCKING_CODES` (SERVICE_ADDRESS/SERVICE_SCHEDULE do serviço + COVERAGE = vínculo
 *     vigente do serviço, spec 087), 1 vaga em rascunho (`is_draft`/status `PENDING_ACTIVATION`), paciente do funil
 *     vai a SEARCHING NA MESMA transação (D469, 02/10/2026: o foguete volta a mover o paciente);
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
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';
import { vincularServicoAoPagador } from './helpers/vinculoPagador';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'activation-e2e-%';
const HORARIO = '[{"dayOfWeek":1,"startTime":"08:00","durationMinutes":240}]';
// Spec 027 Fase 3 (D508 c): os 5 campos que o portão exige e que a vaga copia. Valores sintéticos.
const RECRUITMENT_FIELDS = {
  requiredProfessions: ['AT'],
  requiredSex: 'F',
  requiredExperience: 'EXP-E2E-1',
  workSchedule: 'part-time',
  paymentDay: 'DIA-E2E-5',
};

describe('Ativação de recrutamento por serviço (spec 018, PR-6) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: StaffAuth;
  async function criarPacienteDeFunil(opts: {
    tag: string;
    coverage?: string | null;
    caseNumber?: number;
  }): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number, insurance_informed)
       VALUES ($1, 'Activation', 'E2E', 'AR', 'PENDING_ADMISSION', $2, $3) RETURNING id`,
      [opts.tag, opts.caseNumber ?? null, opts.coverage ?? null],
    )).rows[0].id;
    // Pedido do Javier: ativar recrutamento com o paciente pré-atendimento exige ≥1 diagnóstico ATIVO (esta suíte mede as outras travas).
    await seedPatientDiagnosis(pool, id);
    return id;
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
    // 305: patient_insurance_verified tem FK ON DELETE CASCADE de patients — some junto (o vínculo do serviço, 537, também).
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
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
      { serviceCode: 'AT', addressId, schedule: JSON.parse(HORARIO), ...RECRUITMENT_FIELDS },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;

    // COVERAGE (spec 087): o serviço tem vínculo vigente (contrato ou Particular) — a informada e a verificada não contam mais.
    await vincularServicoAoPagador(pool, serviceId);

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

    // Spec 057 (D523): a vaga com serviço NÃO guarda os 5 (nasce NULL; o leitor lê do serviço) e SEM os dois de ficha;
    // o valor vive no serviço.
    const { rows: [copied] } = await pool.query(
      `SELECT required_professions, required_sex, required_experience, work_schedule, payment_day,
              worker_attributes, daily_obs, worker_profile_sought
         FROM job_postings WHERE id = $1`,
      [r.data.data.vacancyId],
    );
    expect(copied).toMatchObject({
      required_professions: null, required_sex: null, required_experience: null,
      work_schedule: null, payment_day: null,
      worker_attributes: null, daily_obs: null, worker_profile_sought: null,
    });
    const { rows: [svcRow] } = await pool.query(
      `SELECT required_professions, required_sex, required_experience, work_schedule, payment_day
         FROM patient_contracted_services WHERE id = $1`,
      [serviceId],
    );
    expect(svcRow).toMatchObject({
      required_professions: ['AT'], required_sex: 'F', required_experience: 'EXP-E2E-1',
      work_schedule: 'part-time', payment_day: 'DIA-E2E-5',
    });

    const { rows: [patient] } = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`, [patientId],
    );
    expect(patient.status).toBe('SEARCHING');

    // D469: a trilha do paciente carrega a origem do movimento e o operador que clicou.
    const { rows: [hist] } = await pool.query<{ old_value: string; new_value: string; change_source: string }>(
      `SELECT old_value, new_value, change_source FROM patient_status_history
        WHERE patient_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [patientId],
    );
    expect(hist).toEqual({ old_value: 'PENDING_ADMISSION', new_value: 'SEARCHING', change_source: 'recruitment_activation' });

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
      { serviceCode: 'AT', addressId, ...RECRUITMENT_FIELDS },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;
    await vincularServicoAoPagador(pool, serviceId);

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

    // recusado → paciente continua no funil (o movimento do foguete só acontece junto com a vaga criada).
    const { rows: [patient] } = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`, [patientId],
    );
    expect(patient.status).toBe('PENDING_ADMISSION');
  });

  // Spec 087 (decisão 3): `COVERAGE` = o serviço sendo ativado tem vínculo (contrato ou Particular) VIGENTE em `asOf`. Os casos abaixo
  // provam `servicePayerLinkedSql` (o fragmento único do portão) contra Postgres real e que a informada/verificada NÃO destravam.
  const prepararServico = async (tag: string, caseNumber: number, opts: { coverage?: string | null } = {}): Promise<{ patientId: string; serviceId: string }> => {
    const patientId = await criarPacienteDeFunil({ tag, caseNumber, coverage: opts.coverage ?? null });
    const addr = await api.post(`/api/admin/patients/${patientId}/addresses`, { address_formatted: `Av. ${tag} 100`, address_type: 'primary' }, asAdmin);
    const addressId = addr.data.data.id as string;
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: JSON.parse(HORARIO), ...RECRUITMENT_FIELDS },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    return { patientId, serviceId: svc.data.data.id as string };
  };
  const ativar = (patientId: string, serviceId: string) =>
    api.post(`/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, {}, asAdmin);
  const vagasDe = async (patientId: string): Promise<number> =>
    Number((await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [patientId])).rows[0].n);

  it('ALTERNATIVO 3: vínculo VIGENTE (e nada da informada/verificada) → activate-recruitment ACEITA, e cria a vaga do serviço', async () => {
    const { patientId, serviceId } = await prepararServico('activation-e2e-coverage-linked', 991004, { coverage: null });
    await vincularServicoAoPagador(pool, serviceId);

    const r = await ativar(patientId, serviceId);
    expect(r.status).toBe(201);
    expect(r.data.success).toBe(true);
    const { rows: [vacancy] } = await pool.query<{ contracted_service_id: string }>(
      `SELECT contracted_service_id FROM job_postings WHERE id = $1`, [r.data.data.vacancyId],
    );
    expect(vacancy.contracted_service_id).toBe(serviceId);
  });

  it('ALTERNATIVO 4: serviço SEM vínculo, com insurance_informed preenchido E cobertura verificada ativa → 422 com COVERAGE e não cria vaga (o teste que MORRE se o portão voltar a aceitá-las)', async () => {
    const { patientId, serviceId } = await prepararServico('activation-e2e-coverage-missing', 991005, { coverage: 'OSDE' });
    // 'OSDE' é do catálogo seed (migration 311), active=true: ANTES da 087 isto sozinho destravava o portão.
    await pool.query(
      `INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, provider_code, source)
       VALUES ($1, 1, 'OSDE', 'OSDE', 'admin_manual')`,
      [patientId],
    );

    const r = await ativar(patientId, serviceId);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toContain('COVERAGE');
    expect(r.data.details.missing).not.toContain('SERVICE_ADDRESS');
    expect(r.data.details.missing).not.toContain('SERVICE_SCHEDULE');
    expect(await vagasDe(patientId)).toBe(0);
  });

  it('ALTERNATIVO 5: vínculo ENCERRADO (validTo < asOf) → 422 com COVERAGE — mata a vigência (`valid @> asOf`) do fragmento', async () => {
    const { patientId, serviceId } = await prepararServico('activation-e2e-coverage-ended', 991006, { coverage: 'OSDE' });
    await vincularServicoAoPagador(pool, serviceId, 'AR', '[2020-01-01,2020-02-01)');

    const r = await ativar(patientId, serviceId);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toContain('COVERAGE');
    expect(await vagasDe(patientId)).toBe(0);
  });

  it('ALTERNATIVO 6: vínculo FUTURO (começa depois de hoje) → 422 com COVERAGE', async () => {
    const { patientId, serviceId } = await prepararServico('activation-e2e-coverage-future', 991007, { coverage: null });
    await vincularServicoAoPagador(pool, serviceId, 'AR', '[2999-01-01,)');
    const r = await ativar(patientId, serviceId);
    expect(r.status).toBe(422);
    expect(r.data.details.missing).toContain('COVERAGE');
    expect(await vagasDe(patientId)).toBe(0);
  });

  it('ALTERNATIVO (spec 027 Fase 3): serviço sem os 5 campos → 422 com os 5 códigos SERVICE_* por campo, sem criar vaga; required_sex BOTH conta como preenchido', async () => {
    const patientId = await criarPacienteDeFunil({ tag: 'activation-e2e-recfields', caseNumber: 991010 });
    const addr = await api.post(`/api/admin/patients/${patientId}/addresses`, { address_formatted: 'Calle Campos 1', address_type: 'primary' }, asAdmin);
    const addressId = addr.data.data.id as string;
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: JSON.parse(HORARIO) },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;
    await vincularServicoAoPagador(pool, serviceId); // COVERAGE (spec 087) fora da conta: este teste mede os 5 campos
    const url = `/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`;

    const refused = await api.post(url, {}, asAdmin);
    expect(refused.status).toBe(422);
    expect(refused.data.details.missing).toEqual(['SERVICE_REQUIRED_PROFESSIONS', 'SERVICE_REQUIRED_SEX', 'SERVICE_REQUIRED_EXPERIENCE', 'SERVICE_WORK_SCHEDULE', 'SERVICE_PAYMENT_DAY']);
    const { rows: [n] } = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [patientId]);
    expect(Number(n.n)).toBe(0);

    // required_sex: valor fora de M/F/BOTH é 400 na borda (lex S.1), não "aceita qualquer prestador"
    const bad = await api.patch(`/api/admin/patients/${patientId}/contracted-services/${serviceId}`, { requiredSex: 'Mujer' }, asAdmin);
    expect(bad.status).toBe(400);

    // preenche os 5 (BOTH = indistinto = respondido) e ativa: os dois de ficha ficam fora da vaga
    const fill = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { ...RECRUITMENT_FIELDS, requiredSex: 'BOTH', workerAttributes: 'FICHA-ATRIB-E2E', dailyObs: 'FICHA-OBS-E2E' },
      asAdmin,
    );
    expect(fill.status).toBe(200);
    const ok = await api.post(url, {}, asAdmin);
    expect(ok.status).toBe(201);
    const { rows: [v] } = await pool.query(
      'SELECT required_sex, worker_attributes, daily_obs, is_draft FROM job_postings WHERE id = $1',
      [ok.data.data.vacancyId],
    );
    // D523: a vaga não guarda o sexo; o serviço guarda BOTH.
    expect(v).toEqual({ required_sex: null, worker_attributes: null, daily_obs: null, is_draft: true });
    const { rows: [svcSex] } = await pool.query('SELECT required_sex FROM patient_contracted_services WHERE id = $1', [serviceId]);
    expect(svcSex.required_sex).toBe('BOTH');
  });
});
