/**
 * CreateAdminUserUseCase.test.ts
 *
 * Unit tests for the staff-user invitation-link creation flow.
 *
 * Scenarios:
 * 1. Success (admin): creates Firebase user, sets claims, inserts in DB, generates link, sends email
 * 2. Success with custom role (recruiter / community_manager)
 * 3. Invalid role → Result.fail without touching Firebase
 * 4. Firebase createUser failure → rollback, no DB changes, no email
 * 5. DB insert failure → rollback Firebase user (deleteUser called)
 * 6. Email failure is non-fatal — user is persisted + resetLink returned
 * 7. Returns resetLink in the payload even when email succeeds
 * 8. (07/09) `role` saiu do input: a conta nasce com o papel de MENOR privilégio
 *    (`PAPEL_DE_CONTA_NOVA`) — o painel concede acesso por grupo
 * 9. Falha do ROLLBACK e da limpeza do Firebase é reportada, nunca engolida nem relançada
 */

const mockCreateUser = jest.fn();
const mockDeleteUser = jest.fn();
const mockSetCustomUserClaims = jest.fn();
// mergeCustomClaims lê os claims atuais antes de gravar (usuário recém-criado: nenhum)
const mockGetUser = jest.fn();
const mockGeneratePasswordResetLink = jest.fn();
const mockSendInvitationEmail = jest.fn();

jest.mock('firebase-admin', () => ({
  __esModule: true,
  auth: () => ({
    createUser: mockCreateUser,
    deleteUser: mockDeleteUser,
    setCustomUserClaims: mockSetCustomUserClaims,
    getUser: mockGetUser,
    generatePasswordResetLink: mockGeneratePasswordResetLink,
  }),
}));

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockGetPool = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: mockGetPool }),
  },
}));

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../infrastructure/AdminRepository', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../infrastructure/EmailService', () => ({
  EmailService: jest.fn().mockImplementation(() => ({
    sendInvitationEmail: mockSendInvitationEmail,
  })),
}));

import { CreateAdminUserUseCase, PAPEL_DE_CONTA_NOVA } from '../CreateAdminUserUseCase';
import { EnliteRole } from '../../domain/EnliteRole';

describe('CreateAdminUserUseCase', () => {
  beforeEach(() => {
    mockCreateUser.mockReset();
    mockDeleteUser.mockReset();
    mockSetCustomUserClaims.mockReset();
    mockGeneratePasswordResetLink.mockReset();
    mockSendInvitationEmail.mockReset();
    mockQuery.mockReset();
    mockRelease.mockReset();
    mockConnect.mockReset();
    mockGetPool.mockReset();
    mockReportError.mockReset();

    // Default happy-path wiring
    mockDeleteUser.mockResolvedValue(undefined);
    mockSetCustomUserClaims.mockResolvedValue(undefined);
    mockGetUser.mockResolvedValue({ customClaims: undefined });
    mockSendInvitationEmail.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [] });
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockGetPool.mockReturnValue({ connect: mockConnect });
  });

  it('success: full happy path', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-123' });
    mockGeneratePasswordResetLink.mockResolvedValue('https://firebase.link/invite-abc');

    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'newadmin@enlite.health',
      displayName: 'New Admin',
    });

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toMatchObject({
      firebaseUid: 'uid-123',
      email:       'newadmin@enlite.health',
      displayName: 'New Admin',
      resetLink:   'https://firebase.link/invite-abc',
    });
    // 07/09: o papel saiu do contrato — a conta nasce sem grupo, o painel concede.
    expect(result.getValue()).not.toHaveProperty('role');

    expect(mockCreateUser).toHaveBeenCalledWith({
      email:       'newadmin@enlite.health',
      displayName: 'New Admin',
    });
    // No password passed → invitation-link flow
    expect(mockCreateUser.mock.calls[0][0]).not.toHaveProperty('password');
    // O claim `role` continua sendo gravado: é a fronteira staff × prestador e o
    // fallback `untilEnforced` — com o MENOR privilégio (era `admin` por default).
    // D294 (lex C8): SÓ `account_type` entra junto do papel — nenhum outro campo.
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-123', { role: PAPEL_DE_CONTA_NOVA, account_type: 'staff' });
    expect(PAPEL_DE_CONTA_NOVA).toBe(EnliteRole.RECRUITER);
    expect(mockGeneratePasswordResetLink).toHaveBeenCalledWith('newadmin@enlite.health');
    expect(mockSendInvitationEmail).toHaveBeenCalledWith(
      'newadmin@enlite.health',
      'New Admin',
      'https://firebase.link/invite-abc',
    );

    // DB transaction
    const calls = mockQuery.mock.calls.map((c) => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
    expect(calls.some((q: string) => q.includes('create_user_with_role'))).toBe(true);
  });

  it('`role` no input é ignorado por TIPO e por valor — não existe mais escolha de papel', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-rec' });
    mockGeneratePasswordResetLink.mockResolvedValue('https://firebase.link/abc');

    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'rec@enlite.health',
      displayName: 'Rec',
      ...({ role: EnliteRole.ADMIN } as object),
    });

    expect(result.isSuccess).toBe(true);
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-rec', { role: PAPEL_DE_CONTA_NOVA, account_type: 'staff' });
    const createCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('create_user_with_role'));
    expect(createCall?.[1]?.[4]).toBe(PAPEL_DE_CONTA_NOVA);
  });

  it('Firebase createUser failure → Result.fail, no DB changes', async () => {
    mockCreateUser.mockRejectedValue(new Error('Email already exists'));

    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'dup@enlite.health',
      displayName: 'Dup',
    });

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Email already exists');
    // DB BEGIN must NOT have been called before Firebase succeeded
    expect(mockQuery.mock.calls.some((c) => c[0] === 'BEGIN')).toBe(false);
    expect(mockSendInvitationEmail).not.toHaveBeenCalled();
  });

  it('DB insert failure → rollback + Firebase user deletion', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-fail' });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('create_user_with_role')) {
        return Promise.reject(new Error('duplicate key'));
      }
      return Promise.resolve({ rows: [] });
    });

    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'x@test.com',
      displayName: 'X',
    });

    expect(result.isFailure).toBe(true);
    expect(mockDeleteUser).toHaveBeenCalledWith('uid-fail');
    const calls = mockQuery.mock.calls.map((c) => c[0]);
    expect(calls).toContain('ROLLBACK');
    expect(mockSendInvitationEmail).not.toHaveBeenCalled();
  });

  it('ROLLBACK e deleteUser falhando: o erro ORIGINAL é devolvido e os dois secundários vão para reportError', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-fail2' });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('create_user_with_role')) return Promise.reject(new Error('duplicate key'));
      if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback morreu'));
      return Promise.resolve({ rows: [] });
    });
    mockDeleteUser.mockRejectedValue('não-Error de propósito');

    const result = await new CreateAdminUserUseCase().execute({ email: 'x@test.com', displayName: 'X' });

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('duplicate key');
    expect(mockReportError).toHaveBeenCalledTimes(2);
    expect(mockReportError.mock.calls[0][1]).toEqual({ source: 'CreateAdminUserUseCase:rollback' });
    expect(mockReportError.mock.calls[1][0]).toBeInstanceOf(Error);
    expect(mockReportError.mock.calls[1][1]).toEqual({ source: 'CreateAdminUserUseCase:firebaseCleanup', userId: 'uid-fail2' });
    expect(mockRelease).toHaveBeenCalled();
  });

  it('ROLLBACK falhando com não-Error e deleteUser com Error: os dois ramos de normalização', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-fail3' });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('create_user_with_role')) return Promise.reject(new Error('duplicate key'));
      if (sql === 'ROLLBACK') return Promise.reject('rollback string');
      return Promise.resolve({ rows: [] });
    });
    mockDeleteUser.mockRejectedValue(new Error('firebase fora'));

    await new CreateAdminUserUseCase().execute({ email: 'x@test.com', displayName: 'X' });

    expect(mockReportError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((mockReportError.mock.calls[0][0] as Error).message).toBe('rollback string');
    expect((mockReportError.mock.calls[1][0] as Error).message).toBe('firebase fora');
  });

  it('erro que não é Error vira a mensagem genérica', async () => {
    mockCreateUser.mockRejectedValue('string crua');
    const result = await new CreateAdminUserUseCase().execute({ email: 'x@test.com', displayName: 'X' });
    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Failed to create admin user');
  });

  it('email failure is non-fatal — user persisted, resetLink returned', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-ok' });
    mockGeneratePasswordResetLink.mockResolvedValue('https://firebase.link/ok');
    mockSendInvitationEmail.mockRejectedValue(new Error('SendGrid 500'));

    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'ok@enlite.health',
      displayName: 'OK',
    });

    expect(result.isSuccess).toBe(true);
    expect(result.getValue().resetLink).toBe('https://firebase.link/ok');
    // Firebase user was NOT rolled back — email is non-fatal
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

});
