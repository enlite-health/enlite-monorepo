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
 * EXECUTADO em 17/08/2026 contra o Postgres docker (4/4 verdes). O banco é compartilhado
 * com outras suítes, então rodar isolado:
 *   npm run test:e2e:docker -- management-dashboard.integration
 * Por ser compartilhado, as asserções afirmam PISO (>=) sobre as linhas semeadas, nunca
 * total exato — outra suíte rodando em paralelo não pode derrubar este teste.
 */

import { Pool } from 'pg';
import { GetManagementDashboardUseCase } from '../../src/modules/matching/application/GetManagementDashboardUseCase';
import { REQUIRED_SUBSTITUTES } from '../../src/modules/matching/domain/armedCases';
import { CURRENT_WEEK_START_SQL } from '../../src/modules/matching/domain/interviewSchedule';

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
    `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt)
     VALUES ($1, $2, 'registration_incomplete', '[]')`,
    [INCOMPLETE_WORKER_ID, SEARCHING_JOB_ID],
  );

  // 🔒 A LINHA QUE DISCRIMINA — sem ela este teste fica verde com o bug de volta.
  //
  // Worker JÁ REGISTERED com o snapshot congelado em 'registration_incomplete':
  // é o caso real das 169 pessoas que o dashboard contava a mais em produção
  // (735 onde a verdade era 583). A query ANTIGA, que lia a coluna do
  // instantâneo, contava esta linha; a NOVA, que recalcula, não conta.
  //
  // Com só o worker INCOMPLETE_REGISTER acima, as duas versões devolvem o MESMO
  // número e o assert `>= 1` passa nas duas — teste que não distingue o conserto
  // do defeito. Medido em 08/09: antiga=2, nova=1.
  await pool.query(
    `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt)
     VALUES ($1, $2, 'registration_incomplete', '[]')`,
    [REGISTERED_WORKER_ID, SEARCHING_JOB_ID],
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

/**
 * % de capacidade semanal de encuadres — o DENOMINADOR vem da config, não de constante.
 *
 * Por que este bloco existe: `ENCUADRE_WEEKLY_CAPACITY` tem o valor espelhado em quatro
 * lugares (default do código + backend-prd.yml + backend-stg.yml + .env.example) e o teste
 * unitário do default roda com a env APAGADA — ou seja, nenhum teste provava que a env é lida de
 * verdade no caminho completo contra banco. Aqui a mesma agregação roda DUAS vezes com
 * capacidades diferentes: se o denominador estivesse fixo no código, o segundo `execute()`
 * devolveria o mesmo número e o teste quebraria.
 *
 * Fica DEPOIS dos blocos acima de propósito: semeia encuadres na semana corrente no seu
 * próprio `beforeAll`, então as invariantes anteriores medem o banco sem essa interferência.
 */
describe('GetManagementDashboardUseCase — % de capacidade semanal (integration)', () => {
  const SEEDED_ESTA_SEMANA = 3;
  const CAPACIDADE_A = 12;
  const CAPACIDADE_B = 25;
  let capacidadeOriginal: string | undefined;

  beforeAll(async () => {
    capacidadeOriginal = process.env.ENCUADRE_WEEKLY_CAPACITY;

    const jobId = await makeJob('SEARCHING', '1', null, 'capacidade');
    for (let i = 0; i < SEEDED_ESTA_SEMANA; i++) {
      const workerId = await makeWorker('REGISTERED', `capacidade-${i}`);
      // Segunda-feira ao meio-dia no fuso da OPERAÇÃO: sempre dentro da semana corrente,
      // qualquer que seja o dia/hora em que a suíte rodar. Reusa o SSOT de domínio em vez
      // de recalcular o início da semana no teste.
      await pool.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, application_funnel_stage, interview_datetime)
         VALUES ($1, $2, 'CONFIRMED', ${CURRENT_WEEK_START_SQL} + INTERVAL '12 hours')`,
        [workerId, jobId],
      );
    }
  });

  afterAll(() => {
    if (capacidadeOriginal === undefined) delete process.env.ENCUADRE_WEEKLY_CAPACITY;
    else process.env.ENCUADRE_WEEKLY_CAPACITY = capacidadeOriginal;
  });

  it('usa ENCUADRE_WEEKLY_CAPACITY como denominador e mantém pct coerente', async () => {
    process.env.ENCUADRE_WEEKLY_CAPACITY = String(CAPACIDADE_A);
    const dataA = await new GetManagementDashboardUseCase(pool).execute();
    const pctA = dataA.encuadres.pctCapacidadeSemana;

    expect(pctA).toBeDefined();
    expect(pctA!.capacidade).toBe(CAPACIDADE_A);
    // O numerador é o MESMO card exibido na tela — não um segundo cálculo.
    expect(pctA!.agendados).toBe(dataA.encuadres.agendadosEstaSemana);
    // O banco é compartilhado: afirmamos o piso que semeamos, não um total exato.
    expect(pctA!.agendados).toBeGreaterThanOrEqual(SEEDED_ESTA_SEMANA);
    expect(pctA!.pct).toBe(Math.round((pctA!.agendados / CAPACIDADE_A) * 1000) / 10);

    // Trocar só a config muda o denominador (e o pct) sem tocar o numerador.
    process.env.ENCUADRE_WEEKLY_CAPACITY = String(CAPACIDADE_B);
    const dataB = await new GetManagementDashboardUseCase(pool).execute();
    const pctB = dataB.encuadres.pctCapacidadeSemana;

    expect(pctB).toBeDefined();
    expect(pctB!.capacidade).toBe(CAPACIDADE_B);
    expect(pctB!.agendados).toBe(pctA!.agendados);
    expect(pctB!.pct).toBe(Math.round((pctB!.agendados / CAPACIDADE_B) * 1000) / 10);
    expect(pctB!.pct).toBeLessThan(pctA!.pct); // denominador maior → percentual menor
  });

  it('omite o bloco quando a capacidade é inválida (nunca divisão por zero)', async () => {
    process.env.ENCUADRE_WEEKLY_CAPACITY = '0';
    const data = await new GetManagementDashboardUseCase(pool).execute();

    expect(data.encuadres.pctCapacidadeSemana).toBeUndefined();
    // O card cru continua sendo publicado — some o percentual, não o número.
    expect(data.encuadres.agendadosEstaSemana).toBeGreaterThanOrEqual(SEEDED_ESTA_SEMANA);
  });
});

/**
 * 🔒 A GUARDA DO CONSERTO DE 152 PESSOAS.
 *
 * O `bloqueados` do dashboard era a 5ª leitura — a única que continuou lendo o
 * motivo CONGELADO quando as outras quatro passaram a recalcular. Medido em
 * produção em 08/09: contava 735 onde a verdade era 583, inflando 152 pessoas.
 *
 * ⚠️ A primeira versão desta guarda rodava SQL direto no banco e nunca chamava o
 * use case — sabotar o conserto deixava ela VERDE. Teste que não executa o código
 * sob teste não mede nada. Esta versão é DIFERENCIAL e passa pelo use case:
 *
 *   1. roda o dashboard → conta A
 *   2. insere UMA linha do caso que discrimina: worker JÁ REGISTERED com o
 *      snapshot congelado em 'registration_incomplete' (as 169 pessoas reais)
 *   3. roda de novo → conta B
 *
 * Com o motivo recalculado, B === A: a pessoa completou o cadastro, não é mais
 * fila de trabalho. Lendo o snapshot, B === A + 1 — e o assert cai. Diferencial
 * porque o banco é compartilhado: total absoluto não serve.
 */
describe('GetManagementDashboardUseCase — bloqueados conta o motivo de HOJE', () => {
  const W_JA_PRONTO = '99999999-0000-0000-0000-00000000dcba';

  afterAll(async () => {
    await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = $1`, [W_JA_PRONTO]);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [W_JA_PRONTO]);
  });

  it('NÃO conta quem já completou o cadastro, mesmo com o snapshot congelado', async () => {
    const useCase = new GetManagementDashboardUseCase(pool);

    const antes = (await useCase.execute()).funnel.bloqueados;

    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, status, country)
       VALUES ($1::uuid, $2::text, 'ja-pronto@dashboard.test', 'REGISTERED', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [W_JA_PRONTO, `uid-${W_JA_PRONTO}`],
    );
    await pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt)
       VALUES ($1, $2, 'registration_incomplete', '[]')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [W_JA_PRONTO, SEARCHING_JOB_ID],
    );

    const depois = (await useCase.execute()).funnel.bloqueados;

    // Se este assert cair com `depois === antes + 1`, o dashboard voltou a ler o
    // snapshot congelado — é o defeito de 152 pessoas de volta.
    expect(depois).toBe(antes);
  });
});
