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
 * 8. Default role is admin when input.role is omitted
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

jest.mock('../../infrastructure/AdminRepository', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../infrastructure/EmailService', () => ({
  EmailService: jest.fn().mockImplementation(() => ({
    sendInvitationEmail: mockSendInvitationEmail,
  })),
}));

import { CreateAdminUserUseCase } from '../CreateAdminUserUseCase';
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

    // Default happy-path wiring
    mockDeleteUser.mockResolvedValue(undefined);
    mockSetCustomUserClaims.mockResolvedValue(undefined);
    mockGetUser.mockResolvedValue({ customClaims: undefined });
    mockSendInvitationEmail.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [] });
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockGetPool.mockReturnValue({ connect: mockConnect });
  });

  it('success (admin): full happy path', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-123' });
    mockGeneratePasswordResetLink.mockResolvedValue('https://firebase.link/invite-abc');

    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'newadmin@enlite.health',
      displayName: 'New Admin',
      role:        EnliteRole.ADMIN,
    });

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toMatchObject({
      firebaseUid: 'uid-123',
      email:       'newadmin@enlite.health',
      displayName: 'New Admin',
      role:        EnliteRole.ADMIN,
      resetLink:   'https://firebase.link/invite-abc',
    });

    expect(mockCreateUser).toHaveBeenCalledWith({
      email:       'newadmin@enlite.health',
      displayName: 'New Admin',
    });
    // No password passed → invitation-link flow
    expect(mockCreateUser.mock.calls[0][0]).not.toHaveProperty('password');
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-123', { role: EnliteRole.ADMIN });
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

  it('success with custom role (recruiter)', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-rec' });
    mockGeneratePasswordResetLink.mockResolvedValue('https://firebase.link/abc');

    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'rec@enlite.health',
      displayName: 'Rec',
      role:        EnliteRole.RECRUITER,
    });

    expect(result.isSuccess).toBe(true);
    expect(result.getValue().role).toBe(EnliteRole.RECRUITER);
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-rec', { role: EnliteRole.RECRUITER });
  });

  it('invalid role → Result.fail, no Firebase call', async () => {
    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'x@test.com',
      displayName: 'X',
      role:        'hacker' as any,
    });

    expect(result.isFailure).toBe(true);
    expect(result.error).toMatch(/invalid staff role/i);
    expect(mockCreateUser).not.toHaveBeenCalled();
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

  it('default role is admin when role is omitted', async () => {
    mockCreateUser.mockResolvedValue({ uid: 'uid-default' });
    mockGeneratePasswordResetLink.mockResolvedValue('https://firebase.link/default');

    const useCase = new CreateAdminUserUseCase();
    const result = await useCase.execute({
      email:       'default@enlite.health',
      displayName: 'Default',
    });

    expect(result.isSuccess).toBe(true);
    expect(result.getValue().role).toBe(EnliteRole.ADMIN);
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('uid-default', { role: EnliteRole.ADMIN });
  });
});
