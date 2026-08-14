/**
 * O que estes testes travam (ABAC país Fase 1, task 3.1):
 *  - com a flag desligada, NADA muda (o pool é passagem direta);
 *  - com contexto declarado, a request usa UM client fixado — é o que faz o
 *    `SET` de país valer para as 353 leituras soltas;
 *  - staff sem claim de país NÃO vira 'AR' (lex C3): o GUC vai vazio, e sob RLS
 *    isso é zero linha;
 *  - client que não conseguiu limpar o contexto é DESTRUÍDO, nunca devolvido ao
 *    pool (senão o país de um operador vaza para a request seguinte).
 */

import { loggingAls } from '@shared/logging';
import { createRlsAwarePool } from '../rlsAwarePool';
import {
  acquireSessionClient,
  dbPoolRoleFor,
  releaseDbSession,
  sessionClientFor,
  setDbContext,
  withSystemDbContext,
  isCountryCode,
  type DbSession,
  type DbSessionKind,
} from '../requestDbSession';

function makePool() {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
  const pool = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue(client),
    totalCount: 7,
  };
  return { pool: pool as never, rawPool: pool, client };
}

/** Roda `fn` como se fosse uma request com sessão de banco aberta. */
async function inRequest<T>(session: DbSession, fn: () => Promise<T>): Promise<T> {
  return loggingAls.run({ traceId: 'test', dbSession: session }, fn);
}

const ORIGINAL_FLAG = process.env.COUNTRY_RLS_ENABLED;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.COUNTRY_RLS_ENABLED;
  else process.env.COUNTRY_RLS_ENABLED = ORIGINAL_FLAG;
});

describe('rlsAwarePool', () => {
  it('com a flag desligada, passa direto para o pool (comportamento de hoje)', async () => {
    delete process.env.COUNTRY_RLS_ENABLED;
    const { pool, rawPool, client } = makePool();
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await inRequest(session, () => createRlsAwarePool(pool).query('SELECT 1'));

    expect(rawPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(rawPool.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('sem contexto declarado, passa direto (fail-closed fica por conta da policy)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool } = makePool();
    const session: DbSession = { released: false };

    await inRequest(session, () => createRlsAwarePool(pool).query('SELECT 1'));

    expect(rawPool.query).toHaveBeenCalledTimes(1);
    expect(rawPool.connect).not.toHaveBeenCalled();
  });

  it('fora de request (cron legado) não quebra: cai no pool', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool } = makePool();

    await createRlsAwarePool(pool).query('SELECT 1');

    expect(rawPool.query).toHaveBeenCalledTimes(1);
  });

  it('com contexto de staff, aplica o país e FIXA o client entre as queries', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool, client } = makePool();
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };
    const rlsPool = createRlsAwarePool(pool);

    await inRequest(session, async () => {
      await rlsPool.query('SELECT a');
      await rlsPool.query('SELECT b');
    });

    // Uma conexão só para a request inteira
    expect(rawPool.connect).toHaveBeenCalledTimes(1);
    expect(rawPool.query).not.toHaveBeenCalled();

    const [setupSql, setupParams] = client.query.mock.calls[0];
    expect(String(setupSql)).toContain('set_config');
    expect(setupParams).toEqual([
      'app.user_uid', 'u1',
      'app.user_country', 'AR',
      'app.system_context', '',
    ]);
    expect(client.query.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      expect.stringContaining('set_config'),
      'SELECT a',
      'SELECT b',
    ]);
  });

  it('queries concorrentes compartilham UM client (a aquisição é memoizada)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool } = makePool();
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'BR' }, released: false };
    const rlsPool = createRlsAwarePool(pool);

    await inRequest(session, () =>
      Promise.all([rlsPool.query('SELECT a'), rlsPool.query('SELECT b'), rlsPool.query('SELECT c')]),
    );

    expect(rawPool.connect).toHaveBeenCalledTimes(1);
  });

  it('preserva o resto do Pool (propriedades e métodos do alvo)', () => {
    const { pool, rawPool } = makePool();
    const rlsPool = createRlsAwarePool(pool);

    expect(rlsPool.totalCount).toBe(7);
    void rlsPool.connect();
    expect(rawPool.connect).toHaveBeenCalled();
  });
});

describe('contexto sem país (lex C3)', () => {
  it('staff sem claim NÃO vira AR — o GUC vai vazio', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, client } = makePool();
    const session: DbSession = { context: { kind: 'staff', uid: 'u9' }, released: false };

    await inRequest(session, () => createRlsAwarePool(pool).query('SELECT 1'));

    const params = client.query.mock.calls[0][1] as string[];
    expect(params).toEqual(['app.user_uid', 'u9', 'app.user_country', '', 'app.system_context', '']);
    expect(params).not.toContain('AR');
  });

  it('isCountryCode só aceita AR|BR', () => {
    expect(isCountryCode('AR')).toBe(true);
    expect(isCountryCode('BR')).toBe(true);
    expect(isCountryCode('ar')).toBe(false);
    expect(isCountryCode('')).toBe(false);
    expect(isCountryCode(undefined)).toBe(false);
  });
});

describe('releaseDbSession', () => {
  it('limpa os GUCs e devolve o client ao pool', async () => {
    const { pool, client } = makePool();
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await acquireSessionClient(pool, session);
    await releaseDbSession(session);

    const lastSql = String(client.query.mock.calls[client.query.mock.calls.length - 1][0]);
    expect(lastSql).toContain('set_config');
    expect(client.query.mock.calls[client.query.mock.calls.length - 1][1]).toEqual([
      'app.user_uid', 'app.user_country', 'app.system_context',
    ]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('se a limpeza falhar, DESTRÓI o client em vez de devolvê-lo com país dentro', async () => {
    const { pool, client } = makePool();
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await acquireSessionClient(pool, session);
    client.query.mockRejectedValueOnce(new Error('conexão morta'));

    await releaseDbSession(session);

    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('é idempotente (finish + close disparam os dois)', async () => {
    const { pool, client } = makePool();
    const session: DbSession = { context: { kind: 'system', systemContext: 'job:x' }, released: false };

    await acquireSessionClient(pool, session);
    await releaseDbSession(session);
    await releaseDbSession(session);

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('client que não recebeu o contexto não volta pro pool', async () => {
    const { pool, client } = makePool();
    client.query.mockRejectedValueOnce(new Error('falhou o set_config'));
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await expect(acquireSessionClient(pool, session)).rejects.toThrow('falhou o set_config');
    expect(client.release).toHaveBeenCalledWith(true);
    expect(sessionClientFor(session, pool)).toBeUndefined();
  });
});

describe('withSystemDbContext', () => {
  it('declara o contexto de sistema e libera o client no fim', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, client } = makePool();
    const rlsPool = createRlsAwarePool(pool);

    await withSystemDbContext('job:checkin', async () => {
      await rlsPool.query('SELECT 1');
    });

    expect(client.query.mock.calls[0][1]).toEqual([
      'app.user_uid', '',
      'app.user_country', '',
      'app.system_context', 'job:checkin',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('dentro de uma request (webhook), carimba a sessão existente', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool } = makePool();
    const session: DbSession = { released: false };

    await inRequest(session, () =>
      withSystemDbContext('webhook:clickup', async () => {
        expect(session.context).toEqual({ kind: 'system', systemContext: 'webhook:clickup' });
      }),
    );
  });

  it('recusa rótulo vazio — a policy exige contexto declarado, não em branco', async () => {
    await expect(withSystemDbContext('  ', async () => 'x')).rejects.toThrow(/rótulo/);
  });
});

describe('setDbContext', () => {
  it('fora de request é no-op (não explode em job legado)', () => {
    expect(() => setDbContext({ kind: 'system', systemContext: 'job:x' })).not.toThrow();
  });
});

/**
 * UM PROCESSO, DUAS IDENTIDADES (task 3.2).
 *
 * O que estes testes travam: a classe da request escolhe o POOL (identidade de
 * banco), a sessão devolve cada client ao pool de onde ele saiu, e a flag
 * desligada mantém tudo no pool principal — o pool de sistema nem é tocado.
 */
describe('roteamento por identidade (dual-pool)', () => {
  function makeDualPools() {
    const runtime = makePool();
    const system = makePool();
    return {
      runtime,
      system,
      appPool: createRlsAwarePool(runtime.pool, system.pool),
    };
  }

  const CASES: Array<[DbSessionKind, 'runtime' | 'system']> = [
    ['staff', 'runtime'],
    ['worker_self', 'runtime'],
    ['system', 'system'],
    ['public', 'system'],
  ];

  it('dbPoolRoleFor mapeia as 4 classes (worker_self fica no runtime, fail-closed por design)', () => {
    for (const [kind, role] of CASES) expect(dbPoolRoleFor(kind)).toBe(role);
    expect(dbPoolRoleFor(undefined)).toBe('runtime');
  });

  it.each(CASES)('contexto %s sai do pool de %s', async (kind, expected) => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { runtime, system, appPool } = makeDualPools();
    const session: DbSession = {
      context: { kind, uid: 'u1', country: 'AR', systemContext: 'job:x' },
      released: false,
    };

    await inRequest(session, () => appPool.query('SELECT 1'));

    const [used, unused] = expected === 'system' ? [system, runtime] : [runtime, system];
    expect(used.rawPool.connect).toHaveBeenCalledTimes(1);
    expect(used.client.query).toHaveBeenCalledWith('SELECT 1');
    expect(unused.rawPool.connect).not.toHaveBeenCalled();
    expect(unused.rawPool.query).not.toHaveBeenCalled();
  });

  it('flag desligada: contexto de sistema NÃO alcança o pool de sistema', async () => {
    delete process.env.COUNTRY_RLS_ENABLED;
    const { runtime, system, appPool } = makeDualPools();
    const session: DbSession = { context: { kind: 'system', systemContext: 'job:x' }, released: false };

    await inRequest(session, () => appPool.query('SELECT 1'));

    expect(runtime.rawPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(system.rawPool.connect).not.toHaveBeenCalled();
    expect(system.rawPool.query).not.toHaveBeenCalled();
  });

  it('sem envs de sistema (pool único), contexto de sistema usa o pool principal', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool, client } = makePool();
    const appPool = createRlsAwarePool(pool); // 2º argumento omitido = configuração de hoje
    const session: DbSession = { context: { kind: 'system', systemContext: 'job:x' }, released: false };

    await inRequest(session, () => appPool.query('SELECT 1'));

    expect(rawPool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('pool único: trocar de contexto no meio NÃO abre uma segunda conexão', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool } = makePool();
    const appPool = createRlsAwarePool(pool);
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await inRequest(session, async () => {
      await appPool.query('SELECT staff');
      await withSystemDbContext('job:trilha', () => appPool.query('SELECT sistema'));
    });

    expect(rawPool.connect).toHaveBeenCalledTimes(1);
  });

  it('connect() também é roteado — é o que faz withActorContext escrever como sistema', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { runtime, system, appPool } = makeDualPools();

    await inRequest({ context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false }, () =>
      appPool.connect(),
    );
    expect(runtime.rawPool.connect).toHaveBeenCalledTimes(1);
    expect(system.rawPool.connect).not.toHaveBeenCalled();

    await inRequest({ context: { kind: 'system', systemContext: 'job:x' }, released: false }, () =>
      appPool.connect(),
    );
    expect(system.rawPool.connect).toHaveBeenCalledTimes(1);
    expect(runtime.rawPool.connect).toHaveBeenCalledTimes(1);
  });

  it('contexto trocado no meio da request: dois clients, cada um devolvido ao SEU pool', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { runtime, system, appPool } = makeDualPools();
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await inRequest(session, async () => {
      await appPool.query('SELECT staff');
      await withSystemDbContext('job:trilha', () => appPool.query('SELECT sistema'));
    });

    // Nenhum client cruzou a fronteira: cada query rodou na identidade certa.
    expect(runtime.client.query).toHaveBeenCalledWith('SELECT staff');
    expect(runtime.client.query).not.toHaveBeenCalledWith('SELECT sistema');
    expect(system.client.query).toHaveBeenCalledWith('SELECT sistema');
    expect(system.client.query).not.toHaveBeenCalledWith('SELECT staff');

    // A sessão ainda está aberta: ninguém devolveu client antes da hora.
    expect(runtime.client.release).not.toHaveBeenCalled();
    expect(system.client.release).not.toHaveBeenCalled();

    await releaseDbSession(session);

    expect(runtime.client.release).toHaveBeenCalledTimes(1);
    expect(system.client.release).toHaveBeenCalledTimes(1);
    // O contexto foi limpo nos DOIS antes da devolução.
    for (const { client } of [runtime, system]) {
      const [sql, params] = client.query.mock.calls[client.query.mock.calls.length - 1];
      expect(String(sql)).toContain('set_config');
      expect(params).toEqual(['app.user_uid', 'app.user_country', 'app.system_context']);
    }
  });

  it('withSystemDbContext RESTAURA o contexto — staff não fica falando pelo pool de sistema', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { runtime, system, appPool } = makeDualPools();
    const staffContext: DbSession['context'] = { kind: 'staff', uid: 'u1', country: 'AR' };
    const session: DbSession = { context: staffContext, released: false };

    await inRequest(session, async () => {
      await withSystemDbContext('job:trilha', () => appPool.query('SELECT sistema'));
      expect(session.context).toEqual(staffContext);
      await appPool.query('SELECT depois');
    });

    expect(runtime.client.query).toHaveBeenCalledWith('SELECT depois');
    expect(system.client.query).not.toHaveBeenCalledWith('SELECT depois');
  });
});
