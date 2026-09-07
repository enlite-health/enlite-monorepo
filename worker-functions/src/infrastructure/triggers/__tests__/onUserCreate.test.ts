/**
 * onUserCreate — o trigger do Firebase que registra a conta nova em `users`.
 *
 * O que importa desde a D294: o claim gravado é `{ role: 'worker', account_type: 'worker' }`
 * — o tipo viaja junto (a coluna `users.account_type` é derivada pelo trigger da 414
 * a partir do `role` do INSERT). O handler é capturado do `functions.auth.user().onCreate`.
 */
let handler: ((user: Record<string, unknown>) => Promise<void>) | undefined;
jest.mock('firebase-functions', () => ({
  auth: { user: () => ({ onCreate: (h: typeof handler) => { handler = h; return h; } }) },
}));
const mockMerge = jest.fn();
jest.mock('@modules/identity/infrastructure/mergeCustomClaims', () => ({ mergeCustomClaims: (...a: unknown[]) => mockMerge(...a) }));
const mockQuery = jest.fn();
const mockRelease = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ connect: async () => ({ query: mockQuery, release: mockRelease }) }) }) },
}));
const mockReportError = jest.fn();
const logChild = { info: jest.fn(), error: jest.fn() };
jest.mock('@shared/logging', () => ({
  loggingAls: { run: (_ctx: unknown, fn: () => unknown) => fn() },
  logger: { child: () => logChild },
  reportError: (...a: unknown[]) => mockReportError(...a),
}));

import '../onUserCreate';

const user = { uid: 'uid-w', email: 'w@example.com', displayName: 'W', photoURL: null, emailVerified: false };

describe('onUserCreate', () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [] });
    mockMerge.mockReset().mockResolvedValue(undefined);
    mockRelease.mockReset();
    mockReportError.mockReset();
  });

  it('está registrado como trigger', () => {
    expect(typeof handler).toBe('function');
  });

  it('insere em users com role=worker e grava o claim { role: worker, account_type: worker } (D294, lex C8: nada além)', async () => {
    await handler!(user);
    const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO users'));
    expect(insert?.[1]).toEqual(['uid-w', 'w@example.com', 'W', null, 'worker', false]);
    expect(mockMerge).toHaveBeenCalledWith('uid-w', { role: 'worker', account_type: 'worker' });
    expect(mockQuery.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(mockRelease).toHaveBeenCalled();
  });

  it('displayName e photoURL ausentes viram null (não string vazia)', async () => {
    await handler!({ uid: 'u2', email: 'x@example.com', emailVerified: true });
    const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO users'));
    expect(insert?.[1]).toEqual(['u2', 'x@example.com', null, null, 'worker', true]);
  });

  it('falha no meio → ROLLBACK, reportError e relança (nunca conta pela metade)', async () => {
    mockQuery.mockImplementation((sql: string) => (String(sql).includes('INSERT') ? Promise.reject(new Error('db fora')) : Promise.resolve({ rows: [] })));
    await expect(handler!(user)).rejects.toThrow('db fora');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockMerge).not.toHaveBeenCalled();
    expect(mockReportError.mock.calls.map((c) => c[1].source)).toEqual(['onUserCreate']);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('ROLLBACK que também falha (não-Error) é reportado com a própria origem, e o erro original (não-Error) vira Error', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('INSERT')) return Promise.reject('string crua');
      if (sql === 'ROLLBACK') return Promise.reject('rollback string');
      return Promise.resolve({ rows: [] });
    });
    await expect(handler!(user)).rejects.toThrow('string crua');
    expect(mockReportError.mock.calls.map((c) => c[1].source)).toEqual(['onUserCreate:rollback', 'onUserCreate']);
    expect(mockReportError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
  it('ROLLBACK que falha com Error é reportado como está', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('INSERT')) return Promise.reject(new Error('db'));
      if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback morreu'));
      return Promise.resolve({ rows: [] });
    });
    await expect(handler!(user)).rejects.toThrow('db');
    expect((mockReportError.mock.calls[0][0] as Error).message).toBe('rollback morreu');
  });
});
