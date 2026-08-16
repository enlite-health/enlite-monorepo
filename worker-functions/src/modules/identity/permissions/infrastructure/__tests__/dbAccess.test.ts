/**
 * Os dois caminhos de escrita e o de leitura — incluindo o que só aparece
 * quando algo dá errado: ROLLBACK, tradução do erro e devolução do client. É
 * onde um vazamento de conexão passaria despercebido até o pool esgotar em
 * produção.
 */

import { readRows, withStaffWrite, withSystemWrite } from '../dbAccess';
import type { PermissionError } from '../../domain/PermissionError';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

function systemPoolMock(behaviour: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const client = {
    query: jest.fn((sql: string) => behaviour(String(sql))),
    release: jest.fn(),
  };
  return { pool: { connect: jest.fn().mockResolvedValue(client) } as never, client };
}

const sqls = (client: { query: jest.Mock }) => client.query.mock.calls.map((call) => String(call[0]));

describe('withSystemWrite', () => {
  it('declara o contexto de sistema dentro da transação e commita', async () => {
    const { pool, client } = systemPoolMock();
    const out = await withSystemWrite(pool, 'boot:teste', async () => 'ok');
    expect(out).toBe('ok');
    expect(sqls(client)[0]).toBe('BEGIN');
    expect(sqls(client)[1]).toContain('app.system_context');
    expect(client.query).toHaveBeenNthCalledWith(2, expect.any(String), ['boot:teste']);
    expect(sqls(client)[2]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('erro no meio: ROLLBACK, erro traduzido e client devolvido', async () => {
    const { pool, client } = systemPoolMock();
    await expect(
      withSystemWrite(pool, 'boot:teste', async () => {
        throw Object.assign(new Error('sem permissão'), { code: '42501' });
      }),
    ).rejects.toMatchObject({ code: 'forbidden' } as Partial<PermissionError>);
    expect(sqls(client)).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACK que também falha (conexão perdida) não esconde o erro original', async () => {
    const { pool, client } = systemPoolMock(async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('conexão morta');
      if (sql === 'COMMIT') throw new Error('commit falhou');
      return { rows: [] };
    });
    await expect(withSystemWrite(pool, 'boot:teste', async () => 'x')).rejects.toThrow('commit falhou');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('withStaffWrite', () => {
  it('traduz o erro do banco para o vocabulário do módulo', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(client) } as never;
    await expect(
      withStaffWrite(pool, async () => {
        throw Object.assign(new Error('grupo inexistente'), { code: 'P0002' });
      }),
    ).rejects.toMatchObject({ code: 'not_found' } as Partial<PermissionError>);
  });
});

describe('readRows', () => {
  it('devolve o resultado e traduz o erro', async () => {
    expect(await readRows(async () => 42)).toBe(42);
    await expect(
      readRows(async () => {
        throw Object.assign(new Error('sem célula'), { code: '42501' });
      }),
    ).rejects.toMatchObject({ code: 'forbidden' } as Partial<PermissionError>);
  });
});
