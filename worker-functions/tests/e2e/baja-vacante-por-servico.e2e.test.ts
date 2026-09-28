/**
 * baja-vacante-por-servico.e2e.test.ts @integration — change baja-vacante-por-servico
 *
 * Requisito do dono do produto: TODO serviço contratado dado de baixa precisa dar baixa
 * também na(s) vaga(s) ligada(s) — some do WordPress (`GET /api/public/v1/jobs`) e do
 * prestador, mas a PÁGINA da vaga (`GET /api/vacancies/:id`, link direto) continua
 * servindo, mostrando que está desativada. Escopo: só vaga com `contracted_service_id`
 * (vaga órfã fica de fora, decisão do dono).
 *
 * API real + Postgres real. Nenhum side-effect outbound: o caminho é
 * `PATCH .../contracted-services/:sid` → `PatientContractedServiceRepository.update` → UPDATE
 * em `job_postings` na mesma transação — sem Twilio/WhatsApp/Periskope/e-mail (mesma garantia
 * do `activation.e2e.test.ts`, molde deste arquivo).
 *
 * Cenários:
 *   1. FELIZ: baja do serviço → vaga ligada vira DE_BAJA (status_before_baja grava o status
 *      anterior) → some de `GET /api/public/v1/jobs` → `GET /api/vacancies/:id` responde 200
 *      com `status: 'DE_BAJA'` e `is_disabled: true` (não 404).
 *   2. ISOLAMENTO: vaga de OUTRO serviço contratado do MESMO paciente não é afetada pela baja.
 *   3. Vaga sem `contracted_service_id` (órfã) não é tocada por este caminho — fora de escopo.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'baja-vacante-e2e-%';
const HORARIO = '[{"dayOfWeek":2,"startTime":"09:00","endTime":"13:00"}]';

describe('Baja do serviço contratado desativa a vaga ligada (change baja-vacante-por-servico) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: { headers: { Authorization: string } };

  async function criarPaciente(tag: string, caseNumber: number): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number)
       VALUES ($1, 'BajaVacante', 'E2E', 'AR', 'ACTIVE', $2) RETURNING id`,
      [tag, caseNumber],
    )).rows[0].id;
  }

  /**
   * Cria o serviço contratado (endpoint já existente, spec 013 bloco C) e, POR FORA da API
   * (SQL direto), publica uma vaga LIGADA a ele em status público (SEARCHING) — o
   * `activate-recruitment` sempre nasce PENDING_ACTIVATION + is_draft:true (nunca visível no
   * feed), então uma vaga já publicada é o único jeito de provar "sumiu do WordPress" sem
   * depender de um segundo endpoint fora do escopo deste teste.
   */
  async function criarServicoComVagaPublicada(opts: {
    patientId: string;
    caseNumber: number;
    tag: string;
  }): Promise<{ serviceId: string; vacancyId: string }> {
    const svc = await api.post(
      `/api/admin/patients/${opts.patientId}/contracted-services`,
      { serviceCode: 'AT', schedule: JSON.parse(HORARIO) },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    const serviceId = svc.data.data.id as string;

    const vacancyNumber = Math.floor(Math.random() * 900000) + 100000;
    const vacancy = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (
         case_number, vacancy_number, title, status, talentum_description,
         patient_id, contracted_service_id, social_short_links, country, is_draft, is_test
       ) VALUES ($1, $2, $3, 'SEARCHING', $4, $5, $6, $7::jsonb, 'AR', false, false)
       RETURNING id`,
      [
        opts.caseNumber,
        vacancyNumber,
        `CASO ${opts.caseNumber}-${vacancyNumber}`,
        'AT con experiencia — change baja-vacante-por-servico e2e.',
        opts.patientId,
        serviceId,
        JSON.stringify({ site: `https://srt.io/${opts.tag}` }),
      ],
    );
    return { serviceId, vacancyId: vacancy.rows[0].id };
  }

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('baja-vacante-e2e-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(
      `DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(
      `DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    await pool.end();
  });

  it('FELIZ: baja do serviço → vaga vira DE_BAJA, some do feed público, a página da vaga continua servindo desativada', async () => {
    const patientId = await criarPaciente('baja-vacante-e2e-happy', 881001);
    const { serviceId, vacancyId } = await criarServicoComVagaPublicada({
      patientId,
      caseNumber: 881001,
      tag: 'baja-vacante-e2e-happy',
    });

    // Sanity: antes da baja, a vaga aparece no feed público (senão o "some" abaixo não prova nada).
    const antes = await api.get('/api/public/v1/jobs?country=AR');
    expect(antes.status).toBe(200);
    const idsAntes = (antes.data.data as Array<{ id: string }>).map((j) => j.id);
    expect(idsAntes).toContain(vacancyId);

    // Baja do serviço.
    const patch = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { active: false },
      asAdmin,
    );
    expect(patch.status).toBe(200);
    expect(patch.data.data.active).toBe(false);

    // Vaga virou DE_BAJA e guardou o status anterior, direto no banco.
    const row = (await pool.query<{ status: string; status_before_baja: string | null }>(
      `SELECT status, status_before_baja FROM job_postings WHERE id = $1`,
      [vacancyId],
    )).rows[0];
    expect(row.status).toBe('DE_BAJA');
    expect(row.status_before_baja).toBe('SEARCHING');

    // Sumiu do feed público (WordPress).
    const depois = await api.get('/api/public/v1/jobs?country=AR');
    const idsDepois = (depois.data.data as Array<{ id: string }>).map((j) => j.id);
    expect(idsDepois).not.toContain(vacancyId);

    // A página da vaga (link direto) continua servindo — 200, não 404 — mostrando "desativada".
    const detalhe = await api.get(`/api/vacancies/${vacancyId}`);
    expect(detalhe.status).toBe(200);
    expect(detalhe.data.data.status).toBe('DE_BAJA');
    expect(detalhe.data.data.is_disabled).toBe(true);
  });

  it('ISOLAMENTO: baja de UM serviço não afeta a vaga de OUTRO serviço do mesmo paciente', async () => {
    const patientId = await criarPaciente('baja-vacante-e2e-isolation', 881002);
    const alvo = await criarServicoComVagaPublicada({
      patientId,
      caseNumber: 881002,
      tag: 'baja-vacante-e2e-isolation-alvo',
    });
    const outro = await criarServicoComVagaPublicada({
      patientId,
      caseNumber: 881002,
      tag: 'baja-vacante-e2e-isolation-outro',
    });

    const patch = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${alvo.serviceId}`,
      { active: false },
      asAdmin,
    );
    expect(patch.status).toBe(200);

    const rows = (await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM job_postings WHERE id = ANY($1)`,
      [[alvo.vacancyId, outro.vacancyId]],
    )).rows;
    const porId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(porId[alvo.vacancyId]).toBe('DE_BAJA');
    expect(porId[outro.vacancyId]).toBe('SEARCHING'); // intocada

    const feed = await api.get('/api/public/v1/jobs?country=AR');
    const ids = (feed.data.data as Array<{ id: string }>).map((j) => j.id);
    expect(ids).not.toContain(alvo.vacancyId);
    expect(ids).toContain(outro.vacancyId);
  });

  it('FORA DE ESCOPO: vaga órfã (sem contracted_service_id) não é tocada — o WHERE do gatilho é `contracted_service_id = :id`', async () => {
    const patientId = await criarPaciente('baja-vacante-e2e-orphan', 881003);
    // Serviço com vaga ligada (vai levar a baja) + vaga ÓRFÃ do mesmo paciente (não deve mudar).
    const { serviceId } = await criarServicoComVagaPublicada({
      patientId,
      caseNumber: 881003,
      tag: 'baja-vacante-e2e-orphan-svc',
    });
    const vacancyNumber = Math.floor(Math.random() * 900000) + 100000;
    const orfaId = (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (
         case_number, vacancy_number, title, status, talentum_description,
         patient_id, contracted_service_id, social_short_links, country, is_draft, is_test
       ) VALUES ($1, $2, $3, 'SEARCHING', 'Vaga órfã — e2e', $4, NULL, $5::jsonb, 'AR', false, false)
       RETURNING id`,
      [
        881003,
        vacancyNumber,
        `CASO 881003-${vacancyNumber}`,
        patientId,
        JSON.stringify({ site: 'https://srt.io/baja-vacante-e2e-orphan' }),
      ],
    )).rows[0].id;

    await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { active: false },
      asAdmin,
    );

    const orfa = (await pool.query<{ status: string }>(
      `SELECT status FROM job_postings WHERE id = $1`,
      [orfaId],
    )).rows[0];
    expect(orfa.status).toBe('SEARCHING'); // órfã não muda — fora do escopo desta change
  });
});
