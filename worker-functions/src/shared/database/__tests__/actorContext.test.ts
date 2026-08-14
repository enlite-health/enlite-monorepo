import { withActorContext, resolveActor } from '../actorContext';
import { loggingAls } from '@shared/logging';
import { luzActor, staffActor } from '@shared/audit/actorSource';
import { createRlsAwarePool } from '../rlsAwarePool';
import { acquireSessionClient, type DbSession } from '../requestDbSession';

function makePool() {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
  return { pool: pool as never, rawPool: pool, client };
}

/** Só os SQL executados, na ordem — para afirmar BEGIN/set_config/COMMIT. */
const sqlCalls = (client: { query: jest.Mock }) =>
  client.query.mock.calls.map((c) => String(c[0]));

describe('withActorContext', () => {
  it('carimba o ator dentro da transação e faz COMMIT', async () => {
    const { pool, client } = makePool();

    const result = await withActorContext(pool, async () => 'ok', luzActor('apply'));

    expect(result).toBe('ok');
    const sqls = sqlCalls(client);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain('app.current_uid');
    expect(sqls[2]).toContain('app.change_source');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    // set_config LOCAL: precisa vir depois do BEGIN, senão não vale nada
    expect(client.query).toHaveBeenNthCalledWith(2, expect.any(String), ['luz:apply']);
    expect(client.query).toHaveBeenNthCalledWith(3, expect.any(String), ['luz_conversation']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('faz ROLLBACK, propaga o erro e libera a conexão', async () => {
    const { pool, client } = makePool();
    const boom = new Error('falhou no meio');

    await expect(
      withActorContext(pool, async () => {
        throw boom;
      }, luzActor('apply')),
    ).rejects.toThrow(boom);

    expect(sqlCalls(client)).toContain('ROLLBACK');
    expect(sqlCalls(client)).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('sem ator nenhum: transação normal, sem carimbo (comportamento de hoje)', async () => {
    const { pool, client } = makePool();

    await withActorContext(pool, async () => 'ok');

    const sqls = sqlCalls(client);
    expect(sqls).toEqual(['BEGIN', 'COMMIT']);
  });

  it('usa o ator da request (ALS) quando não recebe explícito', async () => {
    const { pool, client } = makePool();
    const actor = staffActor('uid-flor')!;

    await loggingAls.run({ traceId: 't-1', actor }, async () => {
      await withActorContext(pool, async () => 'ok');
    });

    expect(client.query).toHaveBeenNthCalledWith(2, expect.any(String), ['staff:uid-flor']);
    expect(client.query).toHaveBeenNthCalledWith(3, expect.any(String), ['admin_panel']);
  });

  it('ator explícito ganha do ator da request', async () => {
    const { pool, client } = makePool();

    await loggingAls.run({ traceId: 't-2', actor: staffActor('uid-flor')! }, async () => {
      await withActorContext(pool, async () => 'ok', luzActor('book-interview'));
    });

    expect(client.query).toHaveBeenNthCalledWith(2, expect.any(String), ['luz:book-interview']);
  });

  it('release acontece mesmo se o ROLLBACK falhar (conexão perdida)', async () => {
    const { pool, client } = makePool();
    client.query.mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') return Promise.reject(new Error('conexão morta'));
      if (sql === 'BEGIN') return Promise.reject(new Error('sem conexão'));
      return Promise.resolve({ rows: [] });
    });

    await expect(withActorContext(pool, async () => 'ok')).rejects.toThrow('sem conexão');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * BLOCKER-3 — deadlock de pool.
 *
 * A request de leitura FIXA um client até o fim da resposta. Se a escrita no
 * meio dela abrisse uma SEGUNDA conexão, cada request em voo custaria duas
 * conexões: com `DB_POOL_MAX=20`, a partir de ~10 requests simultâneas toda
 * escrita passaria a estourar `connectionTimeoutMillis` — sem nada no código
 * parecer errado. Estes testes travam a reutilização e, principalmente, que o
 * client da SESSÃO não é devolvido pela transação.
 */
describe('withActorContext — client fixado da request', () => {
  const ORIGINAL_FLAG = process.env.COUNTRY_RLS_ENABLED;
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.COUNTRY_RLS_ENABLED;
    else process.env.COUNTRY_RLS_ENABLED = ORIGINAL_FLAG;
  });

  const inRequest = <T>(session: DbSession, fn: () => Promise<T>): Promise<T> =>
    loggingAls.run({ traceId: 'test', dbSession: session }, fn);

  it('reusa o client já fixado: NENHUMA segunda conexão, e ele NÃO é devolvido', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool, client } = makePool();
    const appPool = createRlsAwarePool(pool);
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await inRequest(session, async () => {
      await acquireSessionClient(pool, session); // a leitura da request fixa o client
      await withActorContext(appPool, async () => 'ok', staffActor('uid-flor'));
    });

    expect(rawPool.connect).toHaveBeenCalledTimes(1);
    // O client é da SESSÃO: quem devolve é o dbSessionMiddleware, não a transação.
    expect(client.release).not.toHaveBeenCalled();
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  it('erro na transação faz ROLLBACK e ainda assim não devolve o client da sessão', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, client } = makePool();
    const appPool = createRlsAwarePool(pool);
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await inRequest(session, async () => {
      await acquireSessionClient(pool, session);
      await expect(
        withActorContext(appPool, async () => {
          throw new Error('falhou no meio');
        }),
      ).rejects.toThrow('falhou no meio');
    });

    expect(client.query.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
    expect(client.release).not.toHaveBeenCalled();
  });

  it('contexto de SISTEMA reusa o client do pool de sistema, não o do staff', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const runtime = makePool();
    const system = makePool();
    const appPool = createRlsAwarePool(runtime.pool, system.pool);
    const session: DbSession = { context: { kind: 'system', systemContext: 'job:x' }, released: false };

    await inRequest(session, async () => {
      await acquireSessionClient(system.pool, session);
      await withActorContext(appPool, async () => 'ok');
    });

    expect(system.client.query.mock.calls.map((c) => String(c[0]))).toContain('BEGIN');
    expect(runtime.rawPool.connect).not.toHaveBeenCalled();
  });

  it('sem client fixado ainda abre conexão própria (e a devolve) — job e flag off', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool, client } = makePool();
    const appPool = createRlsAwarePool(pool);
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await inRequest(session, () => withActorContext(appPool, async () => 'ok'));

    expect(rawPool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('sessão já ENCERRADA não empresta client (a trilha que grava após o finish)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, rawPool, client } = makePool();
    const appPool = createRlsAwarePool(pool);
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'AR' }, released: false };

    await inRequest(session, async () => {
      await acquireSessionClient(pool, session);
      session.released = true;
      await withActorContext(appPool, async () => 'ok');
    });

    // Uma conexão da sessão + uma da transação: a segunda É devolvida.
    expect(rawPool.connect).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('carimba o contexto de país da request DENTRO da transação (SET LOCAL)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const { pool, client } = makePool();
    const appPool = createRlsAwarePool(pool);
    const session: DbSession = { context: { kind: 'staff', uid: 'u1', country: 'BR' }, released: false };

    await inRequest(session, () => withActorContext(appPool, async () => 'ok'));

    const countryStamp = client.query.mock.calls.find((c) =>
      String(c[0]).includes('app.user_country'),
    );
    expect(countryStamp?.[1]).toEqual(['u1', 'BR', '']);
  });

  it('fora de request nenhum carimbo de país é aplicado (job legado)', async () => {
    const { pool, client } = makePool();

    await withActorContext(pool, async () => 'ok');

    expect(
      client.query.mock.calls.some((c) => String(c[0]).includes('app.user_country')),
    ).toBe(false);
  });
});

describe('resolveActor', () => {
  it('override > ALS > null', async () => {
    expect(resolveActor(luzActor('apply'))).toEqual(luzActor('apply'));
    expect(resolveActor()).toBeNull();

    await loggingAls.run({ traceId: 't-3', actor: staffActor('uid-x')! }, async () => {
      expect(resolveActor()?.id).toBe('staff:uid-x');
      expect(resolveActor(luzActor('apply'))?.id).toBe('luz:apply');
    });
  });
});
