/**
 * onUserCreate — o trigger do Firebase que registra a conta nova em `users`.
 *
 * O que importa desde a D294: o claim gravado é `{ role: 'worker', account_type: 'worker' }`
 * — o tipo viaja junto (a coluna `users.account_type` é derivada pelo trigger da 414
 * a partir do `role` do INSERT). O handler é capturado do `functions.auth.user().onCreate`.
 *
 * PII guard — achado do gate 12/09: `log.info({ email: user.email, ... })`
 * publicava o e-mail CRU do usuário recém-criado. O trigger já loga
 * `firebaseUid` no contexto do child logger (linha que identifica o usuário
 * sem precisar do e-mail em claro) — o e-mail no payload deve sair mascarado
 * via `maskEmailForLog`.
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
  logger: { child: jest.fn(() => logChild) },
  reportError: (...a: unknown[]) => mockReportError(...a),
}));

import { logger } from '@shared/logging';
import { maskEmailForLog } from '@shared/utils/emailMask';
import '../onUserCreate';

const user = { uid: 'uid-w', email: 'w@example.com', displayName: 'W', photoURL: null, emailVerified: false };

describe('onUserCreate', () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [] });
    mockMerge.mockReset().mockResolvedValue(undefined);
    mockRelease.mockReset();
    mockReportError.mockReset();
    (logger.child as jest.Mock).mockClear();
    logChild.info.mockReset();
    logChild.error.mockReset();
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

  it('mascara o e-mail no log.info, nunca o valor cru (firebaseUid já identifica via child)', async () => {
    const RAW_EMAIL = 'candidata.sensivel@example.com';
    await handler!({ uid: 'firebase-uid-123', email: RAW_EMAIL, displayName: 'Candidata Sensível', emailVerified: true });

    // O child já carrega firebaseUid — confirma que a identificação não depende do e-mail.
    expect(logger.child).toHaveBeenCalledWith(expect.objectContaining({ firebaseUid: 'firebase-uid-123' }));

    const infoArgs = JSON.stringify(logChild.info.mock.calls);
    expect(infoArgs).not.toContain(RAW_EMAIL);
    expect(infoArgs).not.toContain('candidata.sensivel'); // local part não sobrevive nem truncado
    expect(infoArgs).toContain(maskEmailForLog(RAW_EMAIL));
  });

  // O INSERT/UPDATE em `users` continua recebendo o e-mail em claro — é dado
  // de cadastro, não de log; só o LOG precisa mascarar.
  it('o e-mail cru continua indo pro INSERT/UPDATE em `users` (não é isso que muda)', async () => {
    const RAW_EMAIL = 'outra.candidata@example.com';
    await handler!({ uid: 'u3', email: RAW_EMAIL, displayName: 'Outra', emailVerified: true });

    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO users'));
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain(RAW_EMAIL);
  });
});
