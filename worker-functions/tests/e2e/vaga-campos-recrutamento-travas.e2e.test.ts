/**
 * vaga-campos-recrutamento-travas.e2e.test.ts @integration — spec 057 (D523), F5: as TRAVAS dos 5 campos de recrutamento
 * (`required_sex`, `required_professions`, `required_experience`, `work_schedule`, `payment_day`) de uma vaga que nasceu de um
 * serviço contratado. API real (Docker) + Postgres real, HTTP de verdade; SQL só monta o cenário (paciente, publicação por SQL
 * porque o publish real fala com Talentum/Gemini — canal proibido em teste).
 *
 *   a. PUT /api/admin/vacancies/:id com qualquer dos 5 em vaga COM serviço → 422, `locked_fields` ⊇ os 5 (13 no total), vaga intocada;
 *   b. PATCH do serviço apagando o sexo com vaga VIVA → 422 (`ServiceFieldRequiredByLiveVacancyError`), serviço intocado;
 *   c. PATCH F → M com vaga publicada → 1 aviso `required_sex`; o ack (rota real) o fecha;
 *   d. GET admin da vaga com serviço → `locked_fields` com os 13; vaga MANUAL → [].
 *
 * Nenhum canal real. Dado sintético, sem PII nem clínico. Molde: `vaga-le-do-servico-fecho.e2e.test.ts`.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'v057-travas-e2e';

const CINCO = ['required_sex', 'required_professions', 'required_experience', 'work_schedule', 'payment_day'] as const;
/** `SOURCE_LOCKED_FIELDS` (spec 057): as 8 que já eram + os 5 de recrutamento. */
const TREZE = 13;

const SCHEDULE_V1 = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
const PUT_BODY: Record<(typeof CINCO)[number], unknown> = {
  required_sex: 'M',
  required_professions: ['CAREGIVER'],
  required_experience: 'EXP-PUT',
  work_schedule: 'full-time',
  payment_day: 'DIA-PUT',
};

describe('Vaga com serviço: travas dos 5 campos de recrutamento (spec 057, F5) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: StaffAuth;
  let caseSeq = 884800;

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [`${TAG}-%`]);
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [`${TAG}-%`]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TAG}-%`]);
  }

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('v057-travas-e2e-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  /** Paciente + endereço + serviço com sexo F (os 5 preenchidos, como o portão da ativação exige), tudo pela API menos o paciente. */
  async function seedServico(): Promise<{ patientId: string; serviceId: string; caseNumber: number }> {
    const caseNumber = caseSeq++;
    const patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number, health_insurance_name)
       VALUES ($1, 'Travas057', 'E2E', 'AR', 'PENDING_ADMISSION', $2, 'Particular') RETURNING id`,
      [`${TAG}-${caseNumber}`, caseNumber],
    )).rows[0].id;
    const addr = await api.post(`/api/admin/patients/${patientId}/addresses`, { address_formatted: 'Av. Siempre Viva 742', address_type: 'primary' }, asAdmin);
    expect(addr.status).toBe(201);
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      {
        serviceCode: 'AT', addressId: addr.data.data.id, schedule: SCHEDULE_V1, providersNeeded: 2, providerAgeBand: 'AGE_20_30',
        requiredProfessions: ['AT'], requiredSex: 'F', requiredExperience: 'EXP-E2E', workSchedule: 'part-time', paymentDay: 'DIA-E2E',
      },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    return { patientId, serviceId: svc.data.data.id as string, caseNumber };
  }

  async function seedPublicada(): Promise<{ patientId: string; serviceId: string; vacancyId: string }> {
    const { patientId, serviceId } = await seedServico();
    const act = await api.post(`/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, {}, asAdmin);
    expect(act.status).toBe(201);
    const vacancyId = act.data.data.vacancyId as string;
    await pool.query(
      `UPDATE job_postings SET is_draft = false, status = 'SEARCHING', talentum_description = 'AT con experiencia — 057 e2e.',
              social_short_links = $2::jsonb WHERE id = $1`,
      [vacancyId, JSON.stringify({ site: `https://srt.io/${TAG}-${vacancyId}` })],
    );
    return { patientId, serviceId, vacancyId };
  }

  const patchServico = (patientId: string, serviceId: string, body: Record<string, unknown>) =>
    api.patch(`/api/admin/patients/${patientId}/contracted-services/${serviceId}`, body, asAdmin);

  async function getAdmin(vacancyId: string): Promise<Record<string, any>> {
    const r = await api.get(`/api/admin/vacancies/${vacancyId}`, asAdmin);
    expect(r.status).toBe(200);
    return r.data.data;
  }

  const cincoDaVaga = async (vacancyId: string) => (await pool.query(
    `SELECT required_sex, required_professions, required_experience, work_schedule, payment_day FROM job_postings WHERE id = $1`, [vacancyId],
  )).rows[0];
  const NULOS = { required_sex: null, required_professions: null, required_experience: null, work_schedule: null, payment_day: null };

  it('a. PUT de cada um dos 5 (e dos 5 juntos) em vaga COM serviço -> 422 com locked_fields do que foi tentado; a vaga fica intocada', async () => {
    const { vacancyId } = await seedPublicada();
    for (const campo of CINCO) {
      const put = await api.put(`/api/admin/vacancies/${vacancyId}`, { [campo]: PUT_BODY[campo] }, asAdmin);
      expect(put.status).toBe(422);
      expect(put.data.locked_fields).toContain(campo);
      expect(await cincoDaVaga(vacancyId)).toEqual(NULOS); // nada foi escrito
    }
    const todos = await api.put(`/api/admin/vacancies/${vacancyId}`, PUT_BODY, asAdmin);
    expect(todos.status).toBe(422);
    expect(todos.data.locked_fields).toEqual(expect.arrayContaining([...CINCO]));
    expect(await cincoDaVaga(vacancyId)).toEqual(NULOS);
  });

  it('b. PATCH do serviço que apaga o sexo com vaga VIVA -> 422 e o serviço segue com F', async () => {
    const { patientId, serviceId } = await seedPublicada();
    const r = await patchServico(patientId, serviceId, { requiredSex: null });
    expect(r.status).toBe(422);
    console.info(`[057 travas] PATCH requiredSex:null -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    const { rows: [s] } = await pool.query(`SELECT required_sex FROM patient_contracted_services WHERE id = $1`, [serviceId]);
    expect(s.required_sex).toBe('F');
  });

  it('c. PATCH F -> M com vaga publicada abre 1 aviso `required_sex`; o ack (rota real) o fecha', async () => {
    const { patientId, serviceId, vacancyId } = await seedPublicada();
    expect((await getAdmin(vacancyId)).source_change_notices).toEqual([]); // controle: sem aviso antes

    const patch = await patchServico(patientId, serviceId, { requiredSex: 'M' });
    expect(patch.status).toBe(200);
    const { rows: abertos } = await pool.query(
      `SELECT field FROM vacancy_source_change_notices WHERE job_posting_id = $1 AND acknowledged_at IS NULL`, [vacancyId],
);
    expect(abertos.map((n: { field: string }) => n.field)).toEqual(['required_sex']);
    expect((await getAdmin(vacancyId)).source_change_notices.map((n: { field: string }) => n.field)).toEqual(['required_sex']);
    expect((await getAdmin(vacancyId)).required_sex).toBe('M'); // o leitor já mostra o valor novo do serviço
    expect(await cincoDaVaga(vacancyId)).toEqual(NULOS);

    const ack = await api.post(`/api/admin/vacancies/${vacancyId}/source-change-notices/required_sex/ack`, {}, asAdmin);
    expect(ack.status).toBe(200);
    expect((await getAdmin(vacancyId)).source_change_notices).toEqual([]);
    expect((await api.post(`/api/admin/vacancies/${vacancyId}/source-change-notices/required_sex/ack`, {}, asAdmin)).status).toBe(404); // nada aberto
  });

  it('d. GET admin: vaga COM serviço traz locked_fields com os 13 (⊇ os 5); vaga MANUAL traz []', async () => {
    const { vacancyId, patientId } = await seedPublicada();
    const d = await getAdmin(vacancyId);
    expect(d.locked_fields).toHaveLength(TREZE);
    expect(d.locked_fields).toEqual(expect.arrayContaining([...CINCO]));

    const manualId = (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, case_number, patient_id, status, is_draft, required_professions, required_sex, country, is_test)
       VALUES ($1, $2, $3, 'SEARCHING', true, ARRAY['AT'], 'F', 'AR', true) RETURNING id`,
      [`CASO ${caseSeq} manual`, caseSeq++, patientId],
    )).rows[0].id;
    const m = await getAdmin(manualId);
    expect(m.locked_fields).toEqual([]);
    const put = await api.put(`/api/admin/vacancies/${manualId}`, { required_sex: 'M' }, asAdmin); // controle: a manual segue dona
    expect(put.status).toBe(200);
    expect((await getAdmin(manualId)).required_sex).toBe('M');
  });
});
