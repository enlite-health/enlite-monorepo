/**
 * admin-vacancies-list-caso.test.ts — spec 046 F2 (e2e de API, Postgres real, sem mock).
 *
 * `GET /api/admin/vacancies` devolve `caseNumber` (lido do PACIENTE) e `caseOrdinal`, e não devolve
 * mais a string `caso`. A9: título público e resolução do slug/link da vaga NÃO mudam (rota pública
 * por uuid e por slug `caso{jp.case_number}-{vacancy_number}` — a cópia `jp.case_number`, não a do paciente).
 */
import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PATIENT_CASE = 94610;
const PATIENT_CASE_DIVERGENTE = 94620;
const COPIA_DIVERGENTE = 94699;
const SEM_PACIENTE_CASE = 94630;
const TITULO_DIVERGENTE = 'CASO 94699 titulo publico 046-f2';

describe('GET /api/admin/vacancies — coluna Caso (spec 046 F2)', () => {
  const api = createApiClient();
  let pool: Pool;
  let token: string;
  const patientIds: string[] = [];
  let vacFeliz = '';
  let vacDivergente = '';
  let vacSemPaciente = '';
  let vacancyNumberDivergente = 0;

  async function insertVacancy(patientId: string | null, copyCase: number, ordinal: number | null, title: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO job_postings (title, description, country, status, is_draft, patient_id, case_number, case_ordinal)
       VALUES ($1, 'desc', 'AR', 'SEARCHING', false, $2, $3, $4) RETURNING id, vacancy_number`,
      [title, patientId, copyCase, ordinal],
    );
    return r.rows[0].id as string;
  }

  async function newPatient(slug: string, caseNumber: number): Promise<string> {
    const id = await createPatientFixture(pool, slug);
    await pool.query(`UPDATE patients SET case_number = $1 WHERE id = $2`, [caseNumber, id]);
    patientIds.push(id);
    return id;
  }

  async function linhaDaLista(id: string, search: number): Promise<Record<string, unknown>> {
    const res = await api.get(`/api/admin/vacancies?search=${search}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const row = res.data.data.find((v: { id: string }) => v.id === id);
    expect(row).toBeDefined(); // contagem zero é falha: a vaga semeada TEM de estar na lista
    return row;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    token = await getMockToken(api, { uid: 'list-caso-admin', email: 'list-caso-admin@e2e.local', role: 'admin' });
    pool = new Pool({ connectionString: DATABASE_URL });

    vacFeliz = await insertVacancy(await newPatient('caso-feliz', PATIENT_CASE), PATIENT_CASE, 2, 'CASO 94610 046-f2');
    vacDivergente = await insertVacancy(await newPatient('caso-diverge', PATIENT_CASE_DIVERGENTE), COPIA_DIVERGENTE, 1, TITULO_DIVERGENTE);
    vacSemPaciente = await insertVacancy(null, SEM_PACIENTE_CASE, null, 'CASO 94630 046-f2');
    vacancyNumberDivergente = (await pool.query(`SELECT vacancy_number FROM job_postings WHERE id = $1`, [vacDivergente])).rows[0].vacancy_number;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[vacFeliz, vacDivergente, vacSemPaciente].filter(Boolean)]);
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [patientIds]);
    await pool.end();
  });

  it('A5: paciente case_number=94610, case_ordinal=2 -> caseNumber 94610 / caseOrdinal 2, sem `caso`', async () => {
    const row = await linhaDaLista(vacFeliz, PATIENT_CASE);
    expect(row).toMatchObject({ caseNumber: PATIENT_CASE, caseOrdinal: 2 });
    expect(row).not.toHaveProperty('caso');
  });

  it('A6: cópia jp.case_number diferente do paciente -> caseNumber é o do PACIENTE', async () => {
    const row = await linhaDaLista(vacDivergente, COPIA_DIVERGENTE); // a busca ainda casa a cópia
    expect(row.caseNumber).toBe(PATIENT_CASE_DIVERGENTE);
    expect(row.caseOrdinal).toBe(1);
  });

  it('A7: vaga sem paciente -> caseNumber e caseOrdinal null', async () => {
    const row = await linhaDaLista(vacSemPaciente, SEM_PACIENTE_CASE);
    expect(row.caseNumber).toBeNull();
    expect(row.caseOrdinal).toBeNull();
  });

  it('A9: título público e resolução do slug (cópia jp.case_number + vacancy_number) não mudam', async () => {
    const porUuid = await api.get(`/api/vacancies/${vacDivergente}`);
    expect(porUuid.status).toBe(200);
    expect(porUuid.data.data.title).toBe(TITULO_DIVERGENTE);

    const slug = `caso${COPIA_DIVERGENTE}-${vacancyNumberDivergente}`;
    const porSlug = await api.get(`/api/vacancies/${slug}`);
    expect(porSlug.status).toBe(200);
    expect(porSlug.data.data.id).toBe(vacDivergente);
    expect(porSlug.data.data.title).toBe(TITULO_DIVERGENTE);

    // O slug do número do PACIENTE não resolve: a identidade pública segue a cópia (LISTA §7).
    const slugDoPaciente = await api.get(`/api/vacancies/caso${PATIENT_CASE_DIVERGENTE}-${vacancyNumberDivergente}`);
    expect(slugDoPaciente.status).toBe(404);
  });
});
