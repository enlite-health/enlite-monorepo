import { withActorContext, resolveActor } from '../actorContext';
import { loggingAls } from '@shared/logging';
import { luzActor, staffActor } from '@shared/audit/actorSource';

function makePool() {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client) };
  return { pool: pool as never, client };
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
