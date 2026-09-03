/**
 * patient-contracted-services.e2e.test.ts @integration — spec 013, bloco C (migrations 318-321)
 *
 * API real (Docker) + Postgres real. O que prova, contra o `lex-veredito.md`:
 *   1. POST cria o serviço; country NOT NULL derivado do PACIENTE por trigger quando omitido
 *      (C-a.1); created_by gravado na mesma transação (C-a.3).
 *   2. PATCH é Merge Patch parcial — só o campo enviado muda.
 *   3. Baixa (`active:false`) grava `ended_at`; `active:true` é rejeitado pelo schema (sem
 *      rota de reabrir — C-a.4).
 *   4. device_type_codes fora do catálogo → 422, nada escrito.
 *   5. `patients.service_type[]` vira DERIVADO assim que existe 1 serviço ativo — e o espelho
 *      ClickUp (`PATCH .../service`) para de escrever enquanto isso (FR-C1); volta a escrever
 *      quando o serviço é desativado.
 *   6. Prestador: country herda do SERVIÇO (⇒ paciente), não do worker (C-e.1); duplicar par
 *      ATIVO → 409; baixa + reassociar cria linha NOVA, histórico preservado (C-e.2).
 *   7. `hourlyValue` redigido para recruiter/community_manager, cru para admin (C-c.4) — no
 *      GET da lista E no GET /patients/:id embutido.
 *   8. Guarda de posse: :sid de outro paciente → 404 (nunca edita cross-patient).
 *   9. Purge do paciente de teste (D248) leva as 3 tabelas.
 *  10. Activate: serviço ativo × endereço ativo → 1 vaga por par, com contracted_service_id e
 *      providers_needed propagado; paciente SEM serviço cai no fallback (1 vaga por endereço).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pcs-e2e-${RUN}-`;

describe('Serviço contratado — entidade própria (spec 013, bloco C) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let asRecruiter: { headers: { Authorization: string } };
  let pool: Pool;
  let patientAR = '';
  let patientBR = '';
  let workerId = '';

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`pcs-admin-${RUN}`, 'admin');
    asRecruiter = await staffAuth(`pcs-rec-${RUN}`, 'recruiter');
    pool = new Pool({ connectionString: DATABASE_URL });

    patientAR = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, service_type)
       VALUES ($1, 'Servicio', 'Contratado AR', 'AR', 'ACTIVE', ARRAY['AT']) RETURNING id`,
      [`${TASK_PREFIX}ar`],
    )).rows[0].id;
    patientBR = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'Servicio', 'Contratado BR', 'BR', 'ACTIVE') RETURNING id`,
      [`${TASK_PREFIX}br`],
    )).rows[0].id;
    const worker = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, country, timezone) VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
      [`pcs-worker-${RUN}`, `pcs-worker-${RUN}@e2e.local`],
    );
    workerId = worker.rows[0].id;
  });

  afterAll(async () => {
    // job_postings referencia patients (NO ACTION) e contracted_service_id (RESTRICT) — sai
    // primeiro, ou o DELETE de patients aborta (mesma ordem do purge real, PatientTestFixtureService).
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [`${TASK_PREFIX}%`],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
    await pool.end();
  });

  let serviceId = '';

  it('1. POST cria o serviço; country derivado do paciente (trigger); created_by gravado', async () => {
    const r = await api.post(
      `/api/admin/patients/${patientAR}/contracted-services`,
      { serviceCode: 'AT', providersNeeded: 2, weeklyHours: 20, careLocation: 'HOME', hourlyValue: 1500, deviceTypeCodes: ['HOME'] },
      asAdmin,
    );
    expect(r.status).toBe(201);
    expect(r.data.data).toMatchObject({ serviceCode: 'AT', providersNeeded: 2, weeklyHours: 20, careLocation: 'HOME', hourlyValue: 1500, country: 'AR', active: true, deviceTypes: ['HOME'] });
    serviceId = r.data.data.id;
    const { rows: [row] } = await pool.query(`SELECT country, created_by, updated_by FROM patient_contracted_services WHERE id = $1`, [serviceId]);
    expect(row.country).toBe('AR');
    expect(row.created_by).toBeTruthy();
    expect(row.created_by).toBe(row.updated_by); // C-a.3: autoria na mesma transação
  });

  it('2. PATCH é Merge Patch: só o campo enviado muda', async () => {
    const r = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${serviceId}`, { weeklyHours: 25 }, asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.data).toMatchObject({ weeklyHours: 25, providersNeeded: 2, careLocation: 'HOME' });
  });

  it('4. device_type_codes fora do catálogo → 422, nada escrito', async () => {
    const before = (await pool.query(`SELECT weekly_hours FROM patient_contracted_services WHERE id = $1`, [serviceId])).rows[0];
    const r = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${serviceId}`, { deviceTypeCodes: ['NAO_EXISTE'], weeklyHours: 99 }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('DEVICE_TYPE_UNKNOWN');
    const after = (await pool.query(`SELECT weekly_hours FROM patient_contracted_services WHERE id = $1`, [serviceId])).rows[0];
    expect(after).toEqual(before);
  });

  it('7. hourlyValue redigido para recruiter, cru para admin — na lista E no GET /patients/:id', async () => {
    const listAdmin = await api.get(`/api/admin/patients/${patientAR}/contracted-services`, asAdmin);
    expect(listAdmin.data.data.services[0]).toMatchObject({ hourlyValue: 1500, hourlyValueRedacted: false });
    const listRecruiter = await api.get(`/api/admin/patients/${patientAR}/contracted-services`, asRecruiter);
    expect(listRecruiter.data.data.services[0]).toMatchObject({ hourlyValue: null, hourlyValueRedacted: true });

    const detailAdmin = await api.get(`/api/admin/patients/${patientAR}`, asAdmin);
    expect(detailAdmin.data.data.contractedServices[0]).toMatchObject({ hourlyValue: 1500, hourlyValueRedacted: false });
    const detailRecruiter = await api.get(`/api/admin/patients/${patientAR}`, asRecruiter);
    expect(detailRecruiter.data.data.contractedServices[0]).toMatchObject({ hourlyValue: null, hourlyValueRedacted: true });
  });

  it('8. guarda de posse: :sid de OUTRO paciente → 404, nunca edita cross-patient', async () => {
    const r = await api.patch(`/api/admin/patients/${patientBR}/contracted-services/${serviceId}`, { weeklyHours: 1 }, asAdmin);
    expect(r.status).toBe(404);
    const stillAR = (await pool.query(`SELECT patient_id FROM patient_contracted_services WHERE id = $1`, [serviceId])).rows[0];
    expect(stillAR.patient_id).toBe(patientAR);
  });

  it('5. patients.service_type[] vira DERIVADO com serviço ativo; o espelho ClickUp para de escrever; volta quando desativa', async () => {
    // Antes de qualquer serviço, o array era ['AT'] (seed do beforeAll). Com o serviço 'AT'
    // criado no teste 1 e ATIVO, o derivado é ['AT'] também — precisamos de OUTRO código para
    // provar que é o DERIVADO (não coincidência) que está valendo.
    const other = await api.post(`/api/admin/patients/${patientAR}/contracted-services`, { serviceCode: 'NURSE' }, asAdmin);
    expect(other.status).toBe(201);
    const otherId = other.data.data.id as string;

    const derived = (await pool.query(`SELECT service_type FROM patients WHERE id = $1`, [patientAR])).rows[0].service_type;
    expect(derived.sort()).toEqual(['AT', 'NURSE']);

    // O espelho ClickUp tentando escrever (via PATCH /service) NÃO deve mudar o derivado.
    const guarded = await api.patch(`/api/admin/patients/${patientAR}/service`, { serviceType: ['PSYCHOLOGIST'] }, asAdmin);
    expect(guarded.status).toBe(200);
    const stillDerived = (await pool.query(`SELECT service_type FROM patients WHERE id = $1`, [patientAR])).rows[0].service_type;
    expect(stillDerived.sort()).toEqual(['AT', 'NURSE']);

    // Desativar os DOIS serviços ativos: o derivado congela; a guarda libera o próximo write.
    await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${serviceId}`, { active: false }, asAdmin);
    await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${otherId}`, { active: false }, asAdmin);
    const released = await api.patch(`/api/admin/patients/${patientAR}/service`, { serviceType: ['PSYCHOLOGIST'] }, asAdmin);
    expect(released.status).toBe(200);
    const afterRelease = (await pool.query(`SELECT service_type FROM patients WHERE id = $1`, [patientAR])).rows[0].service_type;
    expect(afterRelease).toEqual(['PSYCHOLOGIST']);
  });

  it('3. baixa grava ended_at; active:true não é aceito pelo schema (sem reabrir)', async () => {
    const s = await api.post(`/api/admin/patients/${patientAR}/contracted-services`, { serviceCode: 'CAREGIVER' }, asAdmin);
    const id = s.data.data.id as string;
    const off = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${id}`, { active: false }, asAdmin);
    expect(off.status).toBe(200);
    expect(off.data.data.active).toBe(false);
    expect(off.data.data.endedAt).toBeTruthy();
    const reopen = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${id}`, { active: true }, asAdmin);
    expect(reopen.status).toBe(400); // z.literal(false) recusa `true`
  });

  it('6. prestador: country herda do SERVIÇO (não do worker); duplicar ATIVO → 409; baixa + reassociar preserva histórico', async () => {
    const svc = await api.post(`/api/admin/patients/${patientBR}/contracted-services`, { serviceCode: 'AT' }, asAdmin);
    const svcId = svc.data.data.id as string;
    expect(svc.data.data.country).toBe('BR');

    const assoc = await api.post(`/api/admin/patients/${patientBR}/contracted-services/${svcId}/providers`, { workerId, weeklyHours: 10 }, asAdmin);
    expect(assoc.status).toBe(201);
    expect(assoc.data.data).toMatchObject({ workerId, weeklyHours: 10, active: true, country: 'BR' }); // worker é AR — country vem do serviço

    const dup = await api.post(`/api/admin/patients/${patientBR}/contracted-services/${svcId}/providers`, { workerId }, asAdmin);
    expect(dup.status).toBe(409);
    expect(dup.data.code).toBe('PROVIDER_ALREADY_ACTIVE');

    const providerId = assoc.data.data.id as string;
    const off = await api.patch(`/api/admin/patients/${patientBR}/contracted-services/${svcId}/providers/${providerId}`, { active: false }, asAdmin);
    expect(off.status).toBe(200);
    expect(off.data.data.active).toBe(false);
    expect(off.data.data.endedAt).toBeTruthy();

    const reassoc = await api.post(`/api/admin/patients/${patientBR}/contracted-services/${svcId}/providers`, { workerId, weeklyHours: 5 }, asAdmin);
    expect(reassoc.status).toBe(201);
    expect(reassoc.data.data.id).not.toBe(providerId); // linha NOVA, não reabertura

    const { rows: history } = await pool.query(`SELECT active FROM contracted_service_providers WHERE service_id = $1 ORDER BY created_at`, [svcId]);
    expect(history).toEqual([{ active: false }, { active: true }]); // histórico preservado
  });

  it('9. purge do paciente de teste leva as 3 tabelas (D248)', async () => {
    const testPatient = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, is_test)
       VALUES ($1, 'Purge', 'Teste', 'AR', 'ACTIVE', true) RETURNING id`,
      [`${TASK_PREFIX}purge`],
    )).rows[0].id;
    const svc = await api.post(`/api/admin/patients/${testPatient}/contracted-services`, { serviceCode: 'AT', deviceTypeCodes: ['HOME'] }, asAdmin);
    const svcId = svc.data.data.id as string;
    await api.post(`/api/admin/patients/${testPatient}/contracted-services/${svcId}/providers`, { workerId }, asAdmin);

    expect((await pool.query(`SELECT count(*)::int AS n FROM patient_contracted_services WHERE patient_id = $1`, [testPatient])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM contracted_service_devices WHERE service_id = $1`, [svcId])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM contracted_service_providers WHERE service_id = $1`, [svcId])).rows[0].n).toBe(1);

    const del = await api.delete(`/api/admin/patients/${testPatient}`, asAdmin);
    expect(del.status).toBe(200);

    expect((await pool.query(`SELECT count(*)::int AS n FROM patient_contracted_services WHERE patient_id = $1`, [testPatient])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM contracted_service_devices WHERE service_id = $1`, [svcId])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM contracted_service_providers WHERE service_id = $1`, [svcId])).rows[0].n).toBe(0);
  });

  it('10. activate: serviço ativo × endereço ativo → 1 vaga por par, contracted_service_id + providers_needed; sem serviço cai no fallback por endereço', async () => {
    const withServices = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number)
       VALUES ($1, 'Activate', 'ComServico', 'AR', 'SOLICITANTE', $2) RETURNING id`,
      [`${TASK_PREFIX}act-with`, 900000 + RUN % 90000],
    )).rows[0].id;
    await pool.query(`INSERT INTO patient_addresses (patient_id, address_type, address_formatted, display_order) VALUES ($1,'primary','Calle 1',1),($1,'secondary','Calle 2',2)`, [withServices]);
    const s1 = await api.post(`/api/admin/patients/${withServices}/contracted-services`, { serviceCode: 'AT', providersNeeded: 2, weeklyHours: 20 }, asAdmin);
    const s2 = await api.post(`/api/admin/patients/${withServices}/contracted-services`, { serviceCode: 'CAREGIVER', providersNeeded: 1, weeklyHours: 10 }, asAdmin);

    const act = await api.post(`/api/admin/patients/${withServices}/activate`, {}, asAdmin);
    expect(act.status).toBe(200);
    expect(act.data.data.createdVacancyIds).toHaveLength(4); // 2 serviços × 2 endereços

    const { rows: vacancies } = await pool.query(
      `SELECT contracted_service_id, providers_needed, worker_profile_sought, salary_text FROM job_postings WHERE patient_id = $1 ORDER BY providers_needed`,
      [withServices],
    );
    expect(vacancies).toHaveLength(4);
    const byService = new Map<string, number>();
    for (const v of vacancies) {
      expect(v.worker_profile_sought).toBeNull(); // lex C-b2: NUNCA vem do serviço
      expect(v.salary_text).toBe('A convenir'); // lex C-c.3: NUNCA vem do serviço
      byService.set(v.contracted_service_id, (byService.get(v.contracted_service_id) ?? 0) + 1);
    }
    expect(byService.get(s1.data.data.id)).toBe(2);
    expect(byService.get(s2.data.data.id)).toBe(2);

    // Paciente SEM nenhum serviço ativo: fallback ao comportamento anterior (1 vaga/endereço, sem contracted_service_id).
    const withoutServices = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number)
       VALUES ($1, 'Activate', 'SemServico', 'AR', 'SOLICITANTE', $2) RETURNING id`,
      [`${TASK_PREFIX}act-without`, 900001 + RUN % 90000],
    )).rows[0].id;
    await pool.query(`INSERT INTO patient_addresses (patient_id, address_type, address_formatted, display_order) VALUES ($1,'primary','Calle 3',1)`, [withoutServices]);
    const act2 = await api.post(`/api/admin/patients/${withoutServices}/activate`, {}, asAdmin);
    expect(act2.status).toBe(200);
    expect(act2.data.data.createdVacancyIds).toHaveLength(1);
    const fallbackRow = (await pool.query(`SELECT contracted_service_id FROM job_postings WHERE patient_id = $1`, [withoutServices])).rows[0];
    expect(fallbackRow.contracted_service_id).toBeNull();
  });
});
