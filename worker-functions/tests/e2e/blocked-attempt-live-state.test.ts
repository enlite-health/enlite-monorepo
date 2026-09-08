/**
 * blocked-attempt-live-state.test.ts
 *
 * Banco REAL. Prende o SQL de `blockedAttemptLiveState` à regra de
 * `assertWorkerCanApply` — as duas implementações da mesma pergunta ("esta pessoa
 * passaria no gate agora?"), uma em TypeScript (o gate) e outra em SQL (o card).
 *
 * Por que este arquivo existe (D300): o card exibia o motivo CONGELADO no momento
 * da barrada e nunca mais atualizado. Em 08/09/2026, 135 dos 1.271 cards abertos em
 * produção mostravam motivo errado — 90 deles de gente REGISTERED, isto é, pronta
 * para trabalhar e escondida atrás de um rótulo velho. O recálculo on-read até
 * existia, mas só para os campos faltantes e só quando o motivo congelado JÁ era
 * `registration_incomplete` — exatamente o caso em que ele não muda nada.
 *
 * O teste que faltava não era do conserto: era do INSTRUMENTO. Nenhum teste
 * comparava o que o card diz com o que o gate faz, então a divergência podia
 * nascer e crescer sem nada ficar vermelho. É isso que o caso TABELA abaixo cobre:
 * varre TODOS os estados possíveis do worker e exige que as duas respostas batam.
 * Se alguém mudar `assertWorkerCanApply` e esquecer o SQL (ou o contrário), quebra
 * aqui — que é o único jeito de o defeito não voltar pela tela da recrutadora.
 */

import { Pool } from 'pg';
import {
  liveWorkerJoinSql,
  liveBlockedReasonSql,
  liveMissingFieldsSql,
} from '@modules/matching/infrastructure/blockedAttemptLiveState';
import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
} from '@modules/matching/domain/WorkerApplicationEligibility';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: TEST_DATABASE_URL });

const EMAIL_DOMAIN = '@blockedlivestate.test';

/** Cria um worker no estado pedido e devolve o id. */
async function makeWorker(status: string, opts: { merged?: boolean } = {}): Promise<string> {
  const email = `w${Date.now()}${Math.random().toString(36).slice(2, 8)}${EMAIL_DOMAIN}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
    [`uid-${email}`, email, status],
  );
  const id = rows[0].id;

  if (opts.merged) {
    const { rows: survivor } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country) VALUES ($1, $2, 'REGISTERED', 'AR') RETURNING id`,
      [`uid-s${Date.now()}${Math.random().toString(36).slice(2, 8)}`, `s${Date.now()}${Math.random().toString(36).slice(2, 8)}${EMAIL_DOMAIN}`],
    );
    await pool.query(`UPDATE workers SET merged_into_id = $2 WHERE id = $1`, [id, survivor[0].id]);
  }

  return id;
}

/** O que o SQL do card responde para este worker. */
async function reasonFromSql(workerId: string | null): Promise<string> {
  const { rows } = await pool.query<{ reason: string }>(
    `SELECT ${liveBlockedReasonSql()} AS reason
     FROM (SELECT $1::uuid AS worker_id) wba
     ${liveWorkerJoinSql()}`,
    [workerId],
  );
  return rows[0].reason;
}

/** O que o GATE responde para o mesmo worker. `eligible` = não lançou. */
async function reasonFromGate(workerId: string): Promise<string> {
  try {
    await assertWorkerCanApply(pool, workerId);
    return 'eligible';
  } catch (err) {
    if (err instanceof WorkerNotEligibleError) return err.reason;
    throw err;
  }
}

afterAll(async () => {
  await pool.query(`DELETE FROM workers WHERE email LIKE $1`, [`%${EMAIL_DOMAIN}`]);
  await pool.end();
});

describe('blockedAttemptLiveState — o SQL do card e o gate respondem a mesma coisa', () => {
  // A tabela é o ponto do arquivo: não é um caso feliz, é a varredura do espaço
  // de estados. Qualquer status novo em `workers.status` que ninguém adicionar
  // aqui continua passando — por isso o teste de completude logo abaixo.
  const CASES: Array<{ nome: string; status: string; merged?: boolean; esperado: string }> = [
    { nome: 'REGISTERED → passa no gate',                 status: 'REGISTERED',          esperado: 'eligible' },
    { nome: 'INCOMPLETE_REGISTER → registro incompleto',  status: 'INCOMPLETE_REGISTER', esperado: 'registration_incomplete' },
    { nome: 'DISABLED → worker desativado',               status: 'DISABLED',            esperado: 'worker_disabled' },
    { nome: 'mergeado → o gate não o encontra',           status: 'REGISTERED', merged: true, esperado: 'worker_not_found' },
  ];

  it.each(CASES)('$nome', async ({ status, merged, esperado }) => {
    const workerId = await makeWorker(status, { merged });

    const doSql = await reasonFromSql(workerId);
    const doGate = await reasonFromGate(workerId);

    expect(doSql).toBe(esperado);
    // A asserção que importa: as duas implementações concordam.
    expect(doSql).toBe(doGate);
  });

  it('worker_id nulo (tentativa sem cadastro linkado) → worker_not_found', async () => {
    expect(await reasonFromSql(null)).toBe('worker_not_found');
  });

  it('a tabela cobre TODOS os status que o banco aceita — status novo quebra aqui', async () => {
    // Lê o CHECK vivo em vez de confiar na lista do código: status adicionado por
    // migration futura sem passar por aqui deixaria um estado sem regra de exibição,
    // e o card cairia silenciosamente no ELSE (dizendo "elegível" para quem não é).
    const { rows } = await pool.query<{ definicao: string }>(
      `SELECT pg_get_constraintdef(oid) AS definicao
       FROM pg_constraint
       WHERE conrelid = 'workers'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%status%'`,
    );

    const statusNoBanco = new Set(
      rows
        .flatMap((r) => r.definicao.match(/'[A-Z_]+'::/g) ?? [])
        .map((m) => m.slice(1, -3)),
    );
    expect(statusNoBanco.size).toBeGreaterThan(0);

    const statusCobertos = new Set(CASES.filter((c) => !c.merged).map((c) => c.status));
    for (const status of statusNoBanco) {
      expect(statusCobertos.has(status)).toBe(true);
    }
  });
});

describe('blockedAttemptLiveState — campos faltantes só existem para registro incompleto', () => {
  async function missingFromSql(workerId: string): Promise<string[]> {
    const { rows } = await pool.query<{ campos: string[] }>(
      `SELECT ${liveMissingFieldsSql()} AS campos
       FROM (SELECT $1::uuid AS worker_id) wba
       ${liveWorkerJoinSql()}`,
      [workerId],
    );
    return rows[0].campos;
  }

  it('INCOMPLETE_REGISTER devolve a lista da SSOT do banco, não o snapshot', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER');

    const doSql = await missingFromSql(workerId);
    const { rows } = await pool.query<{ campos: string[] }>(
      `SELECT fn_worker_missing_fields($1) AS campos`,
      [workerId],
    );

    expect(doSql.length).toBeGreaterThan(0);
    expect(doSql).toEqual(rows[0].campos);
  });

  it('DISABLED devolve vazio — não existem "campos faltantes" de quem está desativado', async () => {
    expect(await missingFromSql(await makeWorker('DISABLED'))).toEqual([]);
  });

  it('REGISTERED devolve vazio — nada falta', async () => {
    expect(await missingFromSql(await makeWorker('REGISTERED'))).toEqual([]);
  });
});

/**
 * As três queries de leitura, EXECUTADAS contra o banco.
 *
 * Os testes que já existiam para este repositório mockam o pool: validam o
 * mapeamento do DTO e nunca mandam SQL a lugar nenhum. Foi assim que o `CASE`
 * meio-consertado sobreviveu meses — e, ao escrever este arquivo, foi assim que
 * um `ELSE '{}'::text[]` meu passou no type-check e no unit, e só o banco real
 * recusou (`CASE types text[] and jsonb cannot be matched`). Sem este bloco, o
 * erro chegaria à recrutadora como Kanban em branco.
 *
 * Não asserta conteúdo: asserta que o Postgres ACEITA e responde. É o piso.
 */
describe('BlockedApplicationQueryRepository — as queries rodam no Postgres de verdade', () => {
  const VAGA_INEXISTENTE = '00000000-0000-0000-0000-0000000000aa';
  let repo: import('@modules/matching/infrastructure/BlockedApplicationQueryRepository').BlockedApplicationQueryRepository;

  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const {
      BlockedApplicationQueryRepository,
    } = require('@modules/matching/infrastructure/BlockedApplicationQueryRepository');
    repo = new BlockedApplicationQueryRepository();
  });

  // O repositório abre o pool do singleton; sem fechar, o Jest não sai no CI.
  afterAll(async () => {
    const { DatabaseConnection } = require('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
  });

  it('list() — sem filtro', async () => {
    await expect(repo.list({ limit: 5, offset: 0 })).resolves.toHaveProperty('data');
  });

  it('list() — com filtro de motivo, que agora incide sobre o motivo AO VIVO', async () => {
    const r = await repo.list({ limit: 5, offset: 0, reason: 'eligible' });
    expect(Array.isArray(r.data)).toBe(true);
  });

  it('listByVacancy() — a query do Kanban', async () => {
    await expect(repo.listByVacancy(VAGA_INEXISTENTE)).resolves.toEqual([]);
  });

  it('listByWorker() — a aba de encuadre do prestador', async () => {
    await expect(repo.listByWorker(VAGA_INEXISTENTE)).resolves.toEqual([]);
  });

  it('aggregates() — o contador do topo do painel', async () => {
    await expect(repo.aggregates()).resolves.toHaveProperty('byReason');
  });
});
