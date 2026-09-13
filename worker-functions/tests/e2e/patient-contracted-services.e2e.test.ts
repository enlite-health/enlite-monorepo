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
 *  10. Activate (migration 330, decisão do Gabriel 05/09): UMA vaga POR SERVIÇO, no endereço que
 *      o serviço aponta, com contracted_service_id, providers_needed, franja E horário propagados
 *      — nunca mais serviços × endereços; serviço sem endereço → 422 SERVICE_ADDRESS, nada
 *      criado; paciente SEM serviço cai no fallback (1 vaga por endereço).
 *  13. addressId de OUTRO paciente → 422 ADDRESS_NOT_OF_PATIENT (FK composta, controle no banco);
 *      schedule round-trip (array no formato da vaga), inválido → 400, null limpa.
 *  14. GET /patients/:id → completeness acusa SERVICE_ADDRESS (missing E blocking) para serviço
 *      ativo sem endereço; some ao vincular.
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
      // Spec 015 (US-A6.1): providerAgeBand no POST — round-trip na resposta E na coluna nova.
      { serviceCode: 'AT', providersNeeded: 2, weeklyHours: 20, careLocation: 'HOME', hourlyValue: 1500, deviceTypeCodes: ['HOME'], providerAgeBand: 'AGE_30_45' },
      asAdmin,
    );
    expect(r.status).toBe(201);
    expect(r.data.data).toMatchObject({ serviceCode: 'AT', providersNeeded: 2, weeklyHours: 20, careLocation: 'HOME', hourlyValue: 1500, country: 'AR', active: true, deviceTypes: ['HOME'], providerAgeBand: 'AGE_30_45' });
    serviceId = r.data.data.id;
    const { rows: [row] } = await pool.query(`SELECT country, created_by, updated_by, provider_age_band FROM patient_contracted_services WHERE id = $1`, [serviceId]);
    expect(row.country).toBe('AR');
    expect(row.created_by).toBeTruthy();
    expect(row.created_by).toBe(row.updated_by); // C-a.3: autoria na mesma transação
    expect(row.provider_age_band).toBe('AGE_30_45');
  });

  // Spec 015 (US-A6.1): fora do enum → rejeitado pelo schema (convenção viva deste controller:
  // 400 para erro de VALIDAÇÃO de shape, não 422 — ver relatorio.md LISTA item 1). Nada escrito.
  it('11. providerAgeBand fora do enum → 400, nada escrito', async () => {
    const before = (await pool.query(`SELECT provider_age_band FROM patient_contracted_services WHERE id = $1`, [serviceId])).rows[0];
    const r = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${serviceId}`, { providerAgeBand: 'NAO_EXISTE' }, asAdmin);
    expect(r.status).toBe(400);
    const after = (await pool.query(`SELECT provider_age_band FROM patient_contracted_services WHERE id = $1`, [serviceId])).rows[0];
    expect(after).toEqual(before);
  });

  // Spec 015: PATCH limpa a franja (volta a null, "não informado") — caminho válido.
  it('12. PATCH providerAgeBand:null limpa a franja (volta a "não informado")', async () => {
    const r = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${serviceId}`, { providerAgeBand: null }, asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.data.providerAgeBand).toBeNull();
    // Restaura para os testes seguintes (2/4) não dependerem da ordem.
    await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${serviceId}`, { providerAgeBand: 'AGE_30_45' }, asAdmin);
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

  it('13. addressId: do MESMO paciente grava e volta no GET; de OUTRO paciente → 422 ADDRESS_NOT_OF_PATIENT (o banco recusa, nada escrito); schedule round-trip, inválido → 400, null limpa', async () => {
    const own = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1,'Calle Propia 1',1) RETURNING id`,
      [patientAR],
    )).rows[0].id;
    const foreign = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1,'Calle Ajena 1',1) RETURNING id`,
      [patientBR],
    )).rows[0].id;
    const schedule = [
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' },
    ];

    const ok = await api.post(
      `/api/admin/patients/${patientAR}/contracted-services`,
      { serviceCode: 'NURSE', addressId: own, schedule },
      asAdmin,
    );
    expect(ok.status).toBe(201);
    expect(ok.data.data).toMatchObject({ addressId: own, schedule });
    const sid = ok.data.data.id;
    // Persistido como JSONB array (não como ARRAY Postgres — o driver serializa array JS errado
    // sem o stringify explícito do repositório).
    const { rows: [row] } = await pool.query(`SELECT address_id, schedule, jsonb_typeof(schedule) AS t FROM patient_contracted_services WHERE id = $1`, [sid]);
    expect(row.address_id).toBe(own);
    expect(row.t).toBe('array');
    expect(row.schedule).toEqual(schedule);
    // E volta no GET /patients/:id embutido (o caminho da ficha usa OUTRO mapper).
    const detail = await api.get(`/api/admin/patients/${patientAR}`, asAdmin);
    const embedded = detail.data.data.contractedServices.find((x: { id: string }) => x.id === sid);
    expect(embedded).toMatchObject({ addressId: own, schedule });

    // Endereço de OUTRO paciente: a FK composta (address_id, patient_id) recusa → 422, nada muda.
    const bad = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${sid}`, { addressId: foreign }, asAdmin);
    expect(bad.status).toBe(422);
    expect(bad.data.code).toBe('ADDRESS_NOT_OF_PATIENT');
    const { rows: [still] } = await pool.query(`SELECT address_id FROM patient_contracted_services WHERE id = $1`, [sid]);
    expect(still.address_id).toBe(own);
    // No POST também (é o mesmo caminho de erro, outra transação).
    const badPost = await api.post(`/api/admin/patients/${patientAR}/contracted-services`, { serviceCode: 'NURSE', addressId: foreign }, asAdmin);
    expect(badPost.status).toBe(422);
    expect(badPost.data.code).toBe('ADDRESS_NOT_OF_PATIENT');

    // schedule inválido (hora fora de HH:MM / início depois do fim / dia 7) → 400, nada escrito.
    for (const invalid of [
      [{ dayOfWeek: 1, startTime: '8h', endTime: '12:00' }],
      [{ dayOfWeek: 1, startTime: '14:00', endTime: '12:00' }],
      [{ dayOfWeek: 7, startTime: '08:00', endTime: '12:00' }],
    ]) {
      const r = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${sid}`, { schedule: invalid }, asAdmin);
      expect(r.status).toBe(400);
    }
    expect((await pool.query(`SELECT schedule FROM patient_contracted_services WHERE id = $1`, [sid])).rows[0].schedule).toEqual(schedule);

    // null limpa ("ainda sem horário" é estado legítimo).
    const cleared = await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${sid}`, { schedule: null, addressId: null }, asAdmin);
    expect(cleared.status).toBe(200);
    expect(cleared.data.data.schedule).toBeNull();
    expect(cleared.data.data.addressId).toBeNull();

    await api.patch(`/api/admin/patients/${patientAR}/contracted-services/${sid}`, { active: false }, asAdmin);
  });

  it('14. GET /patients/:id → completeness acusa SERVICE_ADDRESS (missing E blocking) com serviço ativo sem endereço; some ao vincular; endereço ARQUIVADO conta como sem endereço', async () => {
    const pid = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'Checklist', 'ServicioSinDomicilio', 'AR', 'ADMISSION') RETURNING id`,
      [`${TASK_PREFIX}chk`],
    )).rows[0].id;
    const addr = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1,'Calle Chk 1',1) RETURNING id`,
      [pid],
    )).rows[0].id;
    const svc = (await api.post(`/api/admin/patients/${pid}/contracted-services`, { serviceCode: 'AT' }, asAdmin)).data.data.id;

    let c = (await api.get(`/api/admin/patients/${pid}`, asAdmin)).data.data.completeness;
    expect(c.missing).toContain('SERVICE_ADDRESS');
    expect(c.blocking).toContain('SERVICE_ADDRESS');
    expect(c.canActivate).toBe(false);
    // A lista/kanban deriva pela MESMA regra em SQL: needsAttention/INCOMPLETE_ADMISSION.
    const list = await api.get(`/api/admin/patients?search=ServicioSinDomicilio`, asAdmin);
    const me = list.data.data.find((p: { id: string }) => p.id === pid);
    expect(me?.needsAttention).toBe(true);
    expect(me?.attentionReasons).toContain('INCOMPLETE_ADMISSION');

    await api.patch(`/api/admin/patients/${pid}/contracted-services/${svc}`, { addressId: addr }, asAdmin);
    c = (await api.get(`/api/admin/patients/${pid}`, asAdmin)).data.data.completeness;
    expect(c.missing).not.toContain('SERVICE_ADDRESS');
    expect(c.blocking).not.toContain('SERVICE_ADDRESS');

    // Endereço arquivado por baixo do serviço → volta a acusar (o LEFT JOIN exige archived_at IS NULL).
    await pool.query(`UPDATE patient_addresses SET archived_at = NOW() WHERE id = $1`, [addr]);
    c = (await api.get(`/api/admin/patients/${pid}`, asAdmin)).data.data.completeness;
    expect(c.blocking).toContain('SERVICE_ADDRESS');
  });

  // Teste 10 (batch de ativação multi-serviço + fallback por endereço) REMOVIDO — testava
  // `ActivatePatientUseCase`/`POST /:id/activate`, os dois removidos no PR-6 (spec 018, ADR-5).
  // Ativação agora é POR SERVIÇO (`POST /:id/contracted-services/:sid/activate-recruitment`,
  // `activation.e2e.test.ts`) — não existe mais "ativar o paciente inteiro" nem fallback
  // sem serviço (SUP-20: sem serviço não há `:sid` para chamar).
});
