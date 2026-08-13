/**
 * management-dashboard.integration.test.ts
 *
 * Teste de integração com banco REAL para o "Dashboard para Gestão à Vista"
 * (ClickUp 86ajb4qnw) + feature "Equipe Armada = quadro completo".
 * Exercita GetManagementDashboardUseCase.execute() contra o Postgres de teste e
 * valida que os buckets de equipe armada refletem os casos + papéis semeados.
 *
 * NÃO usa API — instancia o use case com o pool direto (mesma agregação do
 * endpoint GET /analytics/dashboard/management).
 *
 * INVARIANTES: migrations 107 (schedule JSONB), 142 (encuadres.role),
 * 209 (worker_blocked_applications), 230 (funnel stages).
 *
 * ⚠️  ESCRITO MAS NÃO EXECUTADO nesta task — o Postgres docker é compartilhado e
 *     colidiria com suites paralelas. Rodar isolado com:
 *       npm run test:e2e:docker -- management-dashboard.integration
 */

import { Pool } from 'pg';
import { GetManagementDashboardUseCase } from '../../src/modules/matching/application/GetManagementDashboardUseCase';
import { REQUIRED_SUBSTITUTES } from '../../src/modules/matching/domain/armedCases';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });
const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const WORKER_IDS: string[] = [];
const JOB_POSTING_IDS: string[] = [];
let INCOMPLETE_WORKER_ID: string;
let REGISTERED_WORKER_ID: string;
let SEARCHING_JOB_ID: string;
let ARMADA_JOB_ID: string;
let POR_ARMAR_JOB_ID: string;
let PENDENTE_JOB_ID: string;

// Turno 08:00-12:00 = 4h/semana no cálculo do JSONB.
const SCHEDULE_4H = JSON.stringify([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }]);

async function makeWorker(
  status: 'INCOMPLETE_REGISTER' | 'REGISTERED',
  tag: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-mgmt-${SUFFIX}-${tag}`, `mgmt-${SUFFIX}-${tag}@dash.test`, status],
  );
  WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

async function makeJob(
  status: string,
  providersNeeded: string | null,
  schedule: string | null,
  tag: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, status, is_draft, country, providers_needed, schedule)
     VALUES ($1, $2, false, 'AR', $3, $4::jsonb) RETURNING id`,
    [`Caso mgmt ${tag} ${SUFFIX}`, status, providersNeeded, schedule],
  );
  JOB_POSTING_IDS.push(rows[0].id);
  return rows[0].id;
}

async function makeSelectedEncuadre(
  workerId: string,
  jobPostingId: string,
  role: 'TITULAR' | 'RAPID_RESPONSE' | null,
  tag: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO encuadres (worker_id, job_posting_id, resultado, role, dedup_hash)
     VALUES ($1, $2, 'SELECCIONADO', $3, $4)`,
    [workerId, jobPostingId, role, `dedup-${SUFFIX}-${tag}`],
  );
}

beforeAll(async () => {
  INCOMPLETE_WORKER_ID = await makeWorker('INCOMPLETE_REGISTER', 'inc');
  REGISTERED_WORKER_ID = await makeWorker('REGISTERED', 'reg');

  // Vaga SEARCHING sem providers_needed → SEM_CONFIG (também alimenta funnel/blocked).
  SEARCHING_JOB_ID = await makeJob('SEARCHING', null, null, 'searching');

  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
     VALUES ($1, $2, 'INVITED')`,
    [REGISTERED_WORKER_ID, SEARCHING_JOB_ID],
  );
  await pool.query(
    `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason, missing_fields)
     VALUES ($1, $2, 'registration_incomplete', '[]')`,
    [INCOMPLETE_WORKER_ID, SEARCHING_JOB_ID],
  );

  // ARMADA: providers_needed=1 → precisa 1 TITULAR + 10 RAPID_RESPONSE, com schedule 4h.
  ARMADA_JOB_ID = await makeJob('SEARCHING', '1', SCHEDULE_4H, 'armada');
  const titular = await makeWorker('REGISTERED', 'armada-tit');
  await makeSelectedEncuadre(titular, ARMADA_JOB_ID, 'TITULAR', 'armada-tit');
  for (let i = 0; i < REQUIRED_SUBSTITUTES; i++) {
    const sub = await makeWorker('REGISTERED', `armada-sub-${i}`);
    await makeSelectedEncuadre(sub, ARMADA_JOB_ID, 'RAPID_RESPONSE', `armada-sub-${i}`);
  }

  // POR_ARMAR: providers_needed=5, 1 TITULAR classificado mas incompleto, schedule 4h.
  POR_ARMAR_JOB_ID = await makeJob('SEARCHING', '5', SCHEDULE_4H, 'porarmar');
  const porArmarTit = await makeWorker('REGISTERED', 'porarmar-tit');
  await makeSelectedEncuadre(porArmarTit, POR_ARMAR_JOB_ID, 'TITULAR', 'porarmar-tit');

  // PENDENTE_CLASSIFICACAO: providers_needed=1, selecionado SEM papel.
  PENDENTE_JOB_ID = await makeJob('SEARCHING', '1', null, 'pendente');
  const pendWorker = await makeWorker('REGISTERED', 'pendente');
  await makeSelectedEncuadre(pendWorker, PENDENTE_JOB_ID, null, 'pendente');
});

afterAll(async () => {
  if (JOB_POSTING_IDS.length) {
    await pool.query(`DELETE FROM encuadres WHERE job_posting_id = ANY($1::uuid[])`, [JOB_POSTING_IDS]);
    await pool.query(`DELETE FROM worker_blocked_applications WHERE job_posting_id = ANY($1::uuid[])`, [JOB_POSTING_IDS]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1::uuid[])`, [JOB_POSTING_IDS]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [JOB_POSTING_IDS]);
  }
  if (WORKER_IDS.length) {
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKER_IDS]);
  }
  await pool.end();
});

describe('GetManagementDashboardUseCase — Equipe Armada (integration)', () => {
  it('classifica os casos semeados nos buckets corretos', async () => {
    const data = await new GetManagementDashboardUseCase(pool).execute();

    // Cada bucket tem pelo menos o caso que semeamos (o banco pode ter outros).
    expect(data.equipoArmada.armados).toBeGreaterThanOrEqual(1);
    expect(data.equipoArmada.porArmar).toBeGreaterThanOrEqual(1);
    expect(data.equipoArmada.pendenteClasificacao).toBeGreaterThanOrEqual(1);
    expect(data.equipoArmada.semConfig).toBeGreaterThanOrEqual(1);

    // Big numbers espelham os buckets.
    expect(data.bigNumbers.equiposArmados).toBe(data.equipoArmada.armados);
    expect(data.bigNumbers.equiposPorArmar).toBe(data.equipoArmada.porArmar);

    // Horas: ARMADA(4h) + POR_ARMAR(4h) semeados; aPreencher inclui o POR_ARMAR.
    expect(data.horas.totais).toBeGreaterThanOrEqual(8);
    expect(data.horas.aPreencher).toBeGreaterThanOrEqual(4);
    expect(data.horas.coberturaConSchedule).toBeGreaterThanOrEqual(2);

    // Funil / cadastros seguem funcionando (regressão).
    expect(data.prioridades.registrosIncompletos).toBeGreaterThanOrEqual(1);
    expect(data.funnel.invitados).toBeGreaterThanOrEqual(1);
    expect(data.funnel.bloqueados).toBeGreaterThanOrEqual(1);
    expect(data.cadastros.leads).toBeGreaterThanOrEqual(2);
  });

  it('mantém o contrato: inteiros >= 0 (horas podem ser decimais >= 0)', async () => {
    const data = await new GetManagementDashboardUseCase(pool).execute();

    // Percorre RECURSIVAMENTE: funnelPorPrestador tem objetos aninhados (porEtapa/
    // consolidado) e campos não-numéricos legítimos (recorte: 'vagas-vivas',
    // somavel: boolean) — a invariante numérica vale para as FOLHAS numéricas.
    let numericLeaves = 0;
    function assertNumbers(node: unknown, path: string): void {
      if (typeof node === 'number') {
        numericLeaves += 1;
        expect(node).toBeGreaterThanOrEqual(0);
        // horas.* são decimais; todo o resto é contagem inteira.
        if (!path.startsWith('horas.')) {
          expect(Number.isInteger(node)).toBe(true);
        }
        return;
      }
      if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          assertNumbers(value, path === '' ? key : `${path}.${key}`);
        }
      }
    }
    assertNumbers(data, '');
    expect(numericLeaves).toBeGreaterThan(20); // o payload é majoritariamente numérico
  });
});
