/**
 * management-dashboard.integration.test.ts
 *
 * Teste de integração com banco REAL para o "Dashboard para Gestão à Vista"
 * (ClickUp 86ajb4qnw). Exercita GetManagementDashboardUseCase.execute() contra
 * o Postgres de teste e valida que os agregados refletem linhas semeadas.
 *
 * NÃO usa API — instancia o use case com o pool direto (mesma agregação do
 * endpoint GET /analytics/dashboard/management).
 *
 * INVARIANTES: migrations 209 (worker_blocked_applications), 230 (funnel stages)
 * e as tabelas job_postings/patients/encuadres aplicadas.
 *
 * ⚠️  ESCRITO MAS NÃO EXECUTADO nesta task — o Postgres docker é compartilhado e
 *     colidiria com suites paralelas. Rodar isolado com:
 *       npm run test:e2e:docker -- management-dashboard.integration
 */

import { Pool } from 'pg';
import { GetManagementDashboardUseCase } from '../../src/modules/matching/application/GetManagementDashboardUseCase';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });
const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const WORKER_IDS: string[] = [];
let INCOMPLETE_WORKER_ID: string;
let REGISTERED_WORKER_ID: string;
let JOB_POSTING_ID: string;

async function makeWorker(status: 'INCOMPLETE_REGISTER' | 'REGISTERED', tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-mgmt-${SUFFIX}-${tag}`, `mgmt-${SUFFIX}-${tag}@dash.test`, status],
  );
  WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

beforeAll(async () => {
  INCOMPLETE_WORKER_ID = await makeWorker('INCOMPLETE_REGISTER', 'inc');
  REGISTERED_WORKER_ID = await makeWorker('REGISTERED', 'reg');

  const jp = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, status, is_draft, country)
     VALUES ($1, 'SEARCHING', false, 'AR') RETURNING id`,
    [`Caso mgmt ${SUFFIX}`],
  );
  JOB_POSTING_ID = jp.rows[0].id;

  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
     VALUES ($1, $2, 'INVITED')`,
    [REGISTERED_WORKER_ID, JOB_POSTING_ID],
  );

  await pool.query(
    `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason, missing_fields)
     VALUES ($1, $2, 'registration_incomplete', '[]')`,
    [INCOMPLETE_WORKER_ID, JOB_POSTING_ID],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM worker_blocked_applications WHERE job_posting_id = $1`, [JOB_POSTING_ID]);
  await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [JOB_POSTING_ID]);
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [JOB_POSTING_ID]);
  if (WORKER_IDS.length) {
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKER_IDS]);
  }
  await pool.end();
});

describe('GetManagementDashboardUseCase (integration)', () => {
  it('retorna o contrato completo com agregados não-negativos', async () => {
    const data = await new GetManagementDashboardUseCase(pool).execute();

    expect(data.bigNumbers.equiposPorArmar).toBeGreaterThanOrEqual(1); // nossa vaga SEARCHING
    expect(data.prioridades.profesionalesBloqueados).toBeGreaterThanOrEqual(1); // nosso incompleto
    expect(data.funnel.invitados).toBeGreaterThanOrEqual(1); // nossa WJA INVITED
    expect(data.funnel.bloqueados).toBeGreaterThanOrEqual(1); // nosso blocked
    expect(data.cadastros.leads).toBeGreaterThanOrEqual(2); // 2 workers semeados
    expect(data.cadastros.completos).toBeGreaterThanOrEqual(1);
    expect(data.cadastros.incompletos).toBeGreaterThanOrEqual(1);

    // Todos os números são inteiros >= 0 (contrato Zod já garante, reforço explícito).
    for (const group of Object.values(data)) {
      for (const value of Object.values(group as Record<string, number>)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
