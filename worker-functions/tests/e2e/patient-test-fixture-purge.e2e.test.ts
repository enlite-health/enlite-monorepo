/**
 * patient-test-fixture-purge.e2e.test.ts
 *
 * E2E do `PatientTestFixtureService.purge` contra POSTGRES REAL.
 *
 * Por que este arquivo existe: o purge é o único caminho do sistema que APAGA
 * paciente, e depois da D248 ele apaga de verdade. O unit test roda com um pool
 * falso — ele prova a decisão ("mandou DELETE?"), não o efeito. Duas classes de
 * defeito só o banco conta:
 *
 *   1. `countCascadeChildren` monta SQL por TEMPLATE a partir de uma lista de
 *      nomes de tabela. Um nome errado passa verde no mock e estoura em produção.
 *   2. As FKs. `ON DELETE CASCADE` levar (ou não) a filha junto é fato do schema,
 *      não do código — e é exatamente o que a C3 do lex mandou proteger.
 *
 * SEM MOCK, exceto o Google Calendar (serviço externo — regra dura do repo).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import {
  PatientTestFixtureService,
  NotATestPatientError,
  TestVacancyHasApplicationsError,
} from '../../src/modules/case/application/PatientTestFixtureService';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** Calendar é externo: substituído. Nada mais é. */
const calendarStub = { deleteEvent: jest.fn(async () => undefined) } as never;

describe('PatientTestFixtureService.purge — Postgres real', () => {
  let pool: Pool;
  let svc: PatientTestFixtureService;
  const criados: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    svc = new PatientTestFixtureService(pool, calendarStub);
  });

  afterAll(async () => {
    // Limpeza própria: o que este teste criou e não apagou sai aqui.
    for (const id of criados) {
      await pool.query('DELETE FROM patients WHERE id = $1', [id]).catch(() => undefined);
    }
    await pool.end();
  });

  async function criarPaciente(isTest: boolean): Promise<string> {
    const id = randomUUID();
    criados.push(id);
    await pool.query(
      `INSERT INTO patients (id, first_name, last_name, status, origin, country, is_test)
       VALUES ($1, 'Solicitante', '', 'SOLICITANTE', 'web_form', 'AR', $2)`,
      [id, isTest],
    );
    return id;
  }

  async function contar(tabela: string, coluna: string, id: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${tabela} WHERE ${coluna} = $1`,
      [id],
    );
    return Number(rows[0].n);
  }

  it('apaga o paciente E as filhas em CASCADE — e a contagem do resultado é a REAL', async () => {
    const id = await criarPaciente(true);
    await pool.query(
      `INSERT INTO patient_status_history (patient_id, new_value) VALUES ($1, 'SOLICITANTE'), ($1, 'ADMISSION')`,
      [id],
    );
    await pool.query(
      `INSERT INTO patient_addresses (patient_id) VALUES ($1)`,
      [id],
    );

    // Spec 017 (lex C4): uma versão do projeto terapêutico — imutável (trigger 416), mas o
    // CASCADE do pai a leva. Precisa de um serviço contratado do MESMO paciente (posse).
    const { rows: [svcRow] } = await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', 'purge-e2e', 'purge-e2e') RETURNING id`,
      [id],
    );
    await pool.query(
      `INSERT INTO patient_therapeutic_projects
         (patient_id, major, minor, contracted_service_id, diagnoses, clinical_context, general_objective,
          specific_objectives, activities, pathology_types, start_date, end_date, created_by)
       VALUES ($1, 1, 0, $2, '[{"uri":"u","code":"c","title":"t"}]', 'ctx', 'obj',
               '[{"id":"a","label":"a"}]', '[{"id":"b","label":"b"}]', '[{"id":"c","label":"c"}]',
               '2026-09-01', '2026-12-31', 'purge-e2e')`,
      [id, svcRow.id],
    );
    // 417 (D301): contato de emergência da cobertura — filha direta, sai no CASCADE. `kind`
    // atualizado para a taxonomia da migration 424 (spec 018, PR-2) — 'AMBULANCE' saiu do CHECK.
    await pool.query(
      `INSERT INTO patient_coverage_emergency_contacts (patient_id, kind, name, phone_encrypted, created_by)
       VALUES ($1, 'PRIVATE_AMBULANCE', 'Ambulancia sintética', 'enc:sintetico', 'purge-e2e')`,
      [id],
    );
    // Spec 018, PR-2: contato externo sem vínculo familiar — filha direta, sai no CASCADE.
    await pool.query(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, created_by)
       VALUES ($1, 'NEIGHBOR', 'Vecina sintética', 'purge-e2e')`,
      [id],
    );

    // O banco grava sozinho a 1a linha de histórico (trigger) — o mock nunca
    // contaria isso. Medimos o que EXISTE antes, em vez de supor o número.
    const historicoAntes = await contar('patient_status_history', 'patient_id', id);
    const enderecosAntes = await contar('patient_addresses', 'patient_id', id);
    expect(historicoAntes).toBeGreaterThanOrEqual(2);
    expect(await contar('patient_therapeutic_projects', 'patient_id', id)).toBe(1);
    expect(await contar('patient_coverage_emergency_contacts', 'patient_id', id)).toBe(1);
    expect(await contar('patient_external_contacts', 'patient_id', id)).toBe(1);

    const result = await svc.purge(id);

    // O efeito, medido no banco — não a intenção do SQL.
    expect(await contar('patients', 'id', id)).toBe(0);
    expect(await contar('patient_status_history', 'patient_id', id)).toBe(0);
    expect(await contar('patient_addresses', 'patient_id', id)).toBe(0);
    expect(await contar('patient_therapeutic_projects', 'patient_id', id)).toBe(0);
    expect(await contar('patient_coverage_emergency_contacts', 'patient_id', id)).toBe(0);
    expect(await contar('patient_external_contacts', 'patient_id', id)).toBe(0);

    // E a contagem do log bate com o que existia. Um nome de tabela errado no
    // template do countCascadeChildren estouraria a query aqui, não em produção.
    expect(result?.cascaded).toMatchObject({
      patient_status_history: historicoAntes,
      patient_addresses: enderecosAntes,
      patient_responsibles: 0,
      patient_chat_ids: 0,
      patient_professionals: 0,
      patient_field_overrides_audit: 0,
      patient_contracted_services: 1,
      patient_therapeutic_projects: 1,
      patient_coverage_emergency_contacts: 1,
      patient_external_contacts: 1,
    });
  });

  it('C3 — vaga com candidatura de prestador REAL: aborta e NADA é perdido', async () => {
    const patientId = await criarPaciente(true);
    const vacancyId = randomUUID();
    const workerId = randomUUID();
    await pool.query(
      `INSERT INTO job_postings (id, patient_id, title) VALUES ($1, $2, 'vaga de teste')`,
      [vacancyId, patientId],
    );
    await pool.query(
      // `status` REGISTERED é exigido por trigger para aceitar candidatura
      // ("cannot apply: status=INCOMPLETE_REGISTER") — outra regra que só o
      // banco real conta.
      `INSERT INTO workers (id, auth_uid, email, status) VALUES ($1, $2, $3, 'REGISTERED')`,
      [workerId, `uid-${workerId}`, `worker-${workerId}@example.com`],
    );
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $2, 'INVITED')`,
      [workerId, vacancyId],
    );

    await expect(svc.purge(patientId)).rejects.toBeInstanceOf(TestVacancyHasApplicationsError);

    // O ROLLBACK é real: paciente, vaga e candidatura continuam de pé.
    expect(await contar('patients', 'id', patientId)).toBe(1);
    expect(await contar('job_postings', 'id', vacancyId)).toBe(1);
    expect(await contar('worker_job_applications', 'job_posting_id', vacancyId)).toBe(1);

    await pool.query('DELETE FROM worker_job_applications WHERE job_posting_id = $1', [vacancyId]);
    await pool.query('DELETE FROM job_postings WHERE id = $1', [vacancyId]);
    await pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
  });

  it('vaga SEM candidatura sai junto com o paciente', async () => {
    const patientId = await criarPaciente(true);
    const vacancyId = randomUUID();
    await pool.query(
      `INSERT INTO job_postings (id, patient_id, title) VALUES ($1, $2, 'vaga sem candidato')`,
      [vacancyId, patientId],
    );

    const result = await svc.purge(patientId);

    expect(result?.vacanciesDeleted).toBe(1);
    expect(await contar('job_postings', 'id', vacancyId)).toBe(0);
    expect(await contar('patients', 'id', patientId)).toBe(0);
  });

  it('a trava sobrevive ao banco real: paciente NÃO-teste continua intocado', async () => {
    const id = await criarPaciente(false);

    await expect(svc.purge(id)).rejects.toBeInstanceOf(NotATestPatientError);

    expect(await contar('patients', 'id', id)).toBe(1);
  });

  it('alcança o paciente JÁ soft-deletado — o passivo da versão anterior', async () => {
    const id = await criarPaciente(true);
    await pool.query('UPDATE patients SET deleted_at = NOW() WHERE id = $1', [id]);

    await expect(svc.purge(id)).resolves.toMatchObject({ patientId: id });

    expect(await contar('patients', 'id', id)).toBe(0);
  });
});
