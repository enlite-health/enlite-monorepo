/**
 * onUserCreate.test.ts
 *
 * PII guard — achado do gate 12/09: `log.info({ email: user.email, ... })`
 * publicava o e-mail CRU do usuário recém-criado. O trigger já loga
 * `firebaseUid` no contexto do child logger (linha que identifica o usuário
 * sem precisar do e-mail em claro) — o e-mail no payload deve sair mascarado
 * via `maskEmailForLog`.
 */

jest.mock('firebase-functions', () => ({
  auth: {
    user: () => ({
      // Testabilidade: em vez de registrar o trigger no runtime do Firebase,
      // devolve o handler cru — o teste chama `onUserCreate(fakeUser)` direto.
      onCreate: (handler: (user: unknown) => Promise<unknown>) => handler,
    }),
  },
}));

const mockSetCustomUserClaims = jest.fn().mockResolvedValue(undefined);
jest.mock('firebase-admin', () => ({
  auth: () => ({ setCustomUserClaims: mockSetCustomUserClaims }),
}));

jest.mock('@shared/database/DatabaseConnection');

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  // loggingAls.run precisa EXECUTAR o callback (não é um logger de verdade) —
  // senão o corpo do trigger inteiro nunca roda.
  loggingAls: { run: jest.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()) },
}));

import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';
import { maskEmailForLog } from '@shared/utils/emailMask';
import { onUserCreate } from '../onUserCreate';

type FakeUserRecord = {
  uid: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  emailVerified: boolean;
};

function makeUser(overrides: Partial<FakeUserRecord> = {}): FakeUserRecord {
  return {
    uid: 'firebase-uid-123',
    email: 'candidata.sensivel@example.com',
    displayName: 'Candidata Sensível',
    emailVerified: true,
    ...overrides,
  };
}

describe('onUserCreate — PII guard', () => {
  let mockQuery: jest.Mock;
  let mockClient: { query: jest.Mock; release: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockClient = { query: mockQuery, release: jest.fn() };
    (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({
      getPool: () => ({ connect: jest.fn().mockResolvedValue(mockClient) }),
    });
    mockSetCustomUserClaims.mockResolvedValue(undefined);
  });

  it('mascara o e-mail no log.info, nunca o valor cru (firebaseUid já identifica via child)', async () => {
    const RAW_EMAIL = 'candidata.sensivel@example.com';
    const user = makeUser({ email: RAW_EMAIL });

    await (onUserCreate as unknown as (u: FakeUserRecord) => Promise<void>)(user);

    // O child já carrega firebaseUid — confirma que a identificação não depende do e-mail.
    expect((logger.child as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ firebaseUid: user.uid }),
    );

    const mockChildLogger = (logger.child as jest.Mock).mock.results[0].value;
    const infoArgs = JSON.stringify((mockChildLogger.info as jest.Mock).mock.calls);
    expect(infoArgs).not.toContain(RAW_EMAIL);
    expect(infoArgs).not.toContain('candidata.sensivel'); // local part não sobrevive nem truncado
    expect(infoArgs).toContain(maskEmailForLog(RAW_EMAIL));
  });

  // O INSERT/UPDATE em `users` continua recebendo o e-mail em claro — é dado
  // de cadastro, não de log; só o LOG precisa mascarar.
  it('o e-mail cru continua indo pro INSERT/UPDATE em `users` (não é isso que muda)', async () => {
    const RAW_EMAIL = 'outra.candidata@example.com';
    const user = makeUser({ email: RAW_EMAIL });

    await (onUserCreate as unknown as (u: FakeUserRecord) => Promise<void>)(user);

    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO users'));
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain(RAW_EMAIL);
  });
});
