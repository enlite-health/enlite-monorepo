/**
 * patient-kanban-services.e2e.test.ts @integration — cadeia-paciente-vacante-itinerario, Fase 8, P7
 *
 * Prova o agregado `GET /api/admin/patients/kanban/services` (DX-8.1, DX-8.4, DX-8.5) contra a API
 * e o Postgres REAIS. Paciente/endereço por SQL (semente, nunca produção); serviço SEMPRE pela API
 * (o slot é derivado do `schedule`, nunca escrito à mão — DX-7.5/DX-8.4); a alocação (worker + WJA +
 * `job_postings.contracted_service_id` + `patient_itinerary_assignment`) por SQL, molde
 * `patient-itinerary-schema.e2e.test.ts` (`source: 'import'` na WJA bypassa
 * `enforce_worker_registered_for_application`). Um paciente por `it` (independentes, sem
 * `describe.serial` — critério 10 do BRIEF-COMUM).
 *
 * Roteiros (a)-(e) = o smoke do P6, agora como `it`s do jest (banco real, sem curl à mão):
 *   (a) 2 pacientes (AR, BR), 1 serviço cada via API com `schedule` → 201.
 *   (b) GET ?country=AR → 200, o paciente AR presente (`cobertas 0`, `contratadas.weekly 20`,
 *       `liveVacancyId null`), o BR ausente.
 *   (c) GET ?country=BR → o BR presente, o AR ausente.
 *   (d) GET ?country=XX → 400.
 *   (e) POST .../activate-recruitment no serviço AR → 201; o agregado passa a devolver
 *       `liveVacancyId` = o `vacancyId` da resposta.
 * Mais (o que o P6 não cobre — precisa de banco, não só da API):
 *   (f) alocação vigente por SQL no slot derivado → `cobertas 4` (4h da faixa seg 08-12).
 *   (g) o MESMO paciente com um 2º serviço sem `schedule` → 2 serviços na resposta, o 2º `cobertas 0`.
 *   (h) serviço baixado (`PATCH { active:false }`) → o paciente some do agregado (a query só lê
 *       `pcs.active`).
 *   (i) paciente com `deleted_at` → some do agregado (o `JOIN` do leitor exige `deleted_at IS NULL`).
 * Toda resposta passa por `assertNoClinicalLeak` (critério 5: `/diagnos|clinic/i` → 0, controle
 * `serviceCode` > 0).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pks-e2e-${RUN}-`;

/** Critério 5: nenhuma ocorrência de dado clínico; controle positivo = `serviceCode` presente. */
function assertNoClinicalLeak(body: unknown): void {
  const json = JSON.stringify(body);
  const clinicalHits = (json.match(/diagnos|clinic/gi) ?? []).length;
  expect(clinicalHits).toBe(0);
  const serviceCodeHits = (json.match(/serviceCode/g) ?? []).length;
  expect(serviceCodeHits).toBeGreaterThan(0);
}

describe('GET /api/admin/patients/kanban/services — agregado do subcard do Kanban (Fase 8, P7) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`pks-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // Ordem: alocações → WJA → vagas → workers → pacientes do RUN (a FK NO ACTION da alocação
    // recusa a cascata da WJA — BRIEF-COMUM regra 11). `job_postings` inclui os do `activate-
    // recruitment` (test (e)): esses têm `patient_id` do paciente, mas o TÍTULO não é do TASK_PREFIX
    // — por isso o filtro casa por título OU por `patient_id` dos pacientes do RUN (senão o DELETE
    // de `patients` bate na FK `job_postings_patient_id_fkey`).
    const prefixLike = `${TASK_PREFIX}%`;
    await pool.query(
      `DELETE FROM patient_itinerary_assignment WHERE application_id IN (
         SELECT id FROM worker_job_applications WHERE job_posting_id IN (
           SELECT id FROM job_postings WHERE title LIKE $1 OR patient_id IN (
             SELECT id FROM patients WHERE clickup_task_id LIKE $1
           )
         )
       )`,
      [prefixLike],
    );
    await pool.query(
      `DELETE FROM worker_job_applications WHERE job_posting_id IN (
         SELECT id FROM job_postings WHERE title LIKE $1 OR patient_id IN (
           SELECT id FROM patients WHERE clickup_task_id LIKE $1
         )
       )`,
      [prefixLike],
    );
    await pool.query(
      `DELETE FROM job_postings WHERE title LIKE $1 OR patient_id IN (
         SELECT id FROM patients WHERE clickup_task_id LIKE $1
       )`,
      [prefixLike],
    );
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [prefixLike]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [prefixLike]);
    await pool.end();
  });

  let seedCounter = 0;

  async function seedPatient(country: 'AR' | 'BR', slug: string): Promise<{ patientId: string; addressId: string }> {
    seedCounter += 1;
    const patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Kanban', 'Services', $2, 'ADMISSION') RETURNING id`,
        [`${TASK_PREFIX}${seedCounter}-${slug}`, country],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, $2) RETURNING id`,
        [patientId, country],
      )
    ).rows[0].id;
    return { patientId, addressId };
  }

  /** Serviço SEMPRE pela API — nunca SQL (o slot é derivado do `schedule`, DX-7.5/DX-8.4). */
  async function createServiceViaApi(
    patientId: string,
    addressId: string,
    opts: { serviceCode: string; weeklyHours?: number; schedule?: Array<{ dayOfWeek: number; startTime: string; endTime: string }> },
  ): Promise<string> {
    const r = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: opts.serviceCode, weeklyHours: opts.weeklyHours, addressId, schedule: opts.schedule },
      asAdmin,
    );
    expect(r.status).toBe(201);
    return r.data.data.id as string;
  }

  async function slotIdOf(serviceId: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM patient_itinerary_slot WHERE contracted_service_id = $1 ORDER BY weekday LIMIT 1`,
      [serviceId],
    );
    if (!r.rows[0]) throw new Error(`nenhum slot derivado para o serviço ${serviceId}`);
    return r.rows[0].id;
  }

  async function getKanbanServices(country?: string) {
    const query = country ? `?country=${encodeURIComponent(country)}` : '';
    return api.get(`/api/admin/patients/kanban/services${query}`, asAdmin);
  }

  /** Alocação vigente por SQL: worker + WJA (`source: 'import'`) + vaga ligada ao serviço + a linha da alocação. */
  async function seedActiveAssignment(
    slug: string,
    serviceId: string,
    slotId: string,
  ): Promise<{ workerId: string; jobPostingId: string; applicationId: string }> {
    const authUid = `${TASK_PREFIX}worker-${slug}`;
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [authUid, `${authUid}@e2e.local`],
      )
    ).rows[0].id;
    const jobPostingId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}vaga-${slug}`, serviceId],
      )
    ).rows[0].id;
    const applicationId = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobPostingId],
      )
    ).rows[0].id;
    // `valid_from` pela data do BANCO, nunca do relógio do runner (o CI roda em UTC) — molde
    // `patient-itinerary-schema.e2e.test.ts` / helper da Fase 7 (BRIEF-COMUM regra 7, achado #3).
    await pool.query(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
       VALUES ($1, $2, $3, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 7, 'ACTIVE', $4, $4)`,
      [slotId, workerId, applicationId, TASK_PREFIX],
    );
    return { workerId, jobPostingId, applicationId };
  }

  it('(a) 2 pacientes (AR, BR), 1 serviço cada via API com schedule → 201', async () => {
    const ar = await seedPatient('AR', 'a-ar');
    const br = await seedPatient('BR', 'a-br');
    const serviceAr = await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    const serviceBr = await createServiceViaApi(br.patientId, br.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    expect(serviceAr).toBeTruthy();
    expect(serviceBr).toBeTruthy();
  });

  it('(b) GET ?country=AR → 200, o paciente AR presente (cobertas 0, weekly 20, liveVacancyId null); o BR ausente', async () => {
    const ar = await seedPatient('AR', 'b-ar');
    const br = await seedPatient('BR', 'b-br');
    const serviceAr = await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    await createServiceViaApi(br.patientId, br.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });

    const res = await getKanbanServices('AR');
    expect(res.status).toBe(200);
    assertNoClinicalLeak(res.data);
    const patientAr = res.data.data.patients.find((p: { patientId: string }) => p.patientId === ar.patientId);
    expect(patientAr).toBeTruthy();
    expect(patientAr.services).toEqual([
      { contractedServiceId: serviceAr, serviceCode: 'AT', contratadas: { weekly: 20, authorized: null }, cobertas: 0, liveVacancyId: null, uncoveredDays: 0 },
    ]);
    expect(res.data.data.patients.some((p: { patientId: string }) => p.patientId === br.patientId)).toBe(false);
  });

  it('(c) GET ?country=BR → o BR presente, o AR ausente', async () => {
    const ar = await seedPatient('AR', 'c-ar');
    const br = await seedPatient('BR', 'c-br');
    await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    const serviceBr = await createServiceViaApi(br.patientId, br.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });

    const res = await getKanbanServices('BR');
    expect(res.status).toBe(200);
    assertNoClinicalLeak(res.data);
    const patientBr = res.data.data.patients.find((p: { patientId: string }) => p.patientId === br.patientId);
    expect(patientBr).toBeTruthy();
    expect(patientBr.services[0].contractedServiceId).toBe(serviceBr);
    expect(res.data.data.patients.some((p: { patientId: string }) => p.patientId === ar.patientId)).toBe(false);
  });

  it('(d) GET ?country=XX → 400', async () => {
    const res = await getKanbanServices('XX');
    expect(res.status).toBe(400);
  });

  it('(e) POST .../activate-recruitment no serviço AR → 201; o agregado passa a devolver liveVacancyId', async () => {
    const ar = await seedPatient('AR', 'e-ar');
    const serviceAr = await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    // Gate de completude (COVERAGE lê `insurance_informed` do PACIENTE, não do serviço — molde P6).
    await pool.query(`UPDATE patients SET insurance_informed = 'OSDE' WHERE id = $1`, [ar.patientId]);

    const activate = await api.post(
      `/api/admin/patients/${ar.patientId}/contracted-services/${serviceAr}/activate-recruitment`,
      {},
      asAdmin,
    );
    expect(activate.status).toBe(201);
    const vacancyId = activate.data.data.vacancyId as string;
    expect(vacancyId).toBeTruthy();

    const res = await getKanbanServices('AR');
    expect(res.status).toBe(200);
    assertNoClinicalLeak(res.data);
    const patientAr = res.data.data.patients.find((p: { patientId: string }) => p.patientId === ar.patientId);
    expect(patientAr.services[0].liveVacancyId).toBe(vacancyId);
  });

  it('(f) alocação vigente por SQL no slot derivado → cobertas 4', async () => {
    const ar = await seedPatient('AR', 'f-ar');
    const serviceAr = await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    const slotId = await slotIdOf(serviceAr);
    await seedActiveAssignment('f', serviceAr, slotId);

    const res = await getKanbanServices('AR');
    expect(res.status).toBe(200);
    assertNoClinicalLeak(res.data);
    const patientAr = res.data.data.patients.find((p: { patientId: string }) => p.patientId === ar.patientId);
    expect(patientAr.services[0].cobertas).toBe(4);
  });

  it('(g) o MESMO paciente com um 2º serviço sem schedule → 2 serviços na resposta, o 2º cobertas 0', async () => {
    const ar = await seedPatient('AR', 'g-ar');
    const serviceComHorario = await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    const slotId = await slotIdOf(serviceComHorario);
    await seedActiveAssignment('g', serviceComHorario, slotId);
    const serviceSemHorario = await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'NURSE',
      weeklyHours: 15,
    });

    const res = await getKanbanServices('AR');
    expect(res.status).toBe(200);
    assertNoClinicalLeak(res.data);
    const patientAr = res.data.data.patients.find((p: { patientId: string }) => p.patientId === ar.patientId);
    expect(patientAr.services).toHaveLength(2);
    const svcComHorario = patientAr.services.find((s: { contractedServiceId: string }) => s.contractedServiceId === serviceComHorario);
    const svcSemHorario = patientAr.services.find((s: { contractedServiceId: string }) => s.contractedServiceId === serviceSemHorario);
    expect(svcComHorario.cobertas).toBe(4);
    expect(svcSemHorario.cobertas).toBe(0);
  });

  it('(h) serviço baixado (active:false) → o paciente some do agregado', async () => {
    const ar = await seedPatient('AR', 'h-ar');
    const serviceAr = await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    const before = await getKanbanServices('AR');
    expect(before.data.data.patients.some((p: { patientId: string }) => p.patientId === ar.patientId)).toBe(true);

    const off = await api.patch(
      `/api/admin/patients/${ar.patientId}/contracted-services/${serviceAr}`,
      { active: false },
      asAdmin,
    );
    expect(off.status).toBe(200);

    const after = await getKanbanServices('AR');
    expect(after.status).toBe(200);
    assertNoClinicalLeak(after.data);
    expect(after.data.data.patients.some((p: { patientId: string }) => p.patientId === ar.patientId)).toBe(false);
  });

  it('(i) paciente com deleted_at → some do agregado', async () => {
    const ar = await seedPatient('AR', 'i-ar');
    await createServiceViaApi(ar.patientId, ar.addressId, {
      serviceCode: 'AT',
      weeklyHours: 20,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    });
    const before = await getKanbanServices('AR');
    expect(before.data.data.patients.some((p: { patientId: string }) => p.patientId === ar.patientId)).toBe(true);

    await pool.query(`UPDATE patients SET deleted_at = now() WHERE id = $1`, [ar.patientId]);

    const after = await getKanbanServices('AR');
    expect(after.status).toBe(200);
    assertNoClinicalLeak(after.data);
    expect(after.data.data.patients.some((p: { patientId: string }) => p.patientId === ar.patientId)).toBe(false);
  });
});
