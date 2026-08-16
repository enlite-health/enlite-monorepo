/**
 * GetAdminProfileUseCase.test.ts
 *
 * Testa o perfil de admin com auto-provisioning para usuários @enlite.health.
 *
 * Cenários:
 * 1. Admin já cadastrado no banco — login normal, sem provisioning
 * 2. Novo usuário @enlite.health — auto-provisioning completo (Firebase + DB)
 * 3. Email fora do domínio @enlite.health — acesso negado
 * 4. Erro no banco durante auto-provisioning — ROLLBACK e Result.fail
 * 5. Firebase user sem displayName — usa parte do email como displayName
 */

// ─── Mocks de módulo (devem vir antes de qualquer import) ─────────────────────

const mockFindByFirebaseUid = jest.fn();
const mockUpdateLastLogin = jest.fn();
const mockFindByEmail = jest.fn();
const mockReassignFirebaseUid = jest.fn();

jest.mock('../../infrastructure/AdminRepository', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({
    findByFirebaseUid: mockFindByFirebaseUid,
    updateLastLogin: mockUpdateLastLogin,
    findByEmail: mockFindByEmail,
    reassignFirebaseUid: mockReassignFirebaseUid,
  })),
}));

const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockQuery,
  release: mockRelease,
});

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({
      getPool: () => ({
        connect: mockConnect,
      }),
    }),
  },
}));

const mockGetUser = jest.fn();
const mockSetCustomUserClaims = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({
    getUser: mockGetUser,
    setCustomUserClaims: mockSetCustomUserClaims,
  }),
}));

// ─── Imports (após os mocks) ──────────────────────────────────────────────────

import { GetAdminProfileUseCase } from '../GetAdminProfileUseCase';
import { AdminRecord } from '../../infrastructure/AdminRepository';

// ─── Dados de teste realistas ─────────────────────────────────────────────────

const FIREBASE_UID = 'firebase-uid-abc123XYZ';

const mockAdminRecord: AdminRecord = {
  firebaseUid: FIREBASE_UID,
  email: 'joao.silva@enlite.health',
  displayName: 'João Silva',
  role: 'admin',
  department: null,
  lastLoginAt: null,
  loginCount: 0,
  createdAt: '2024-06-01T10:00:00.000Z',
};

const makeFirebaseUser = (overrides: Partial<{
  email: string;
  displayName: string | undefined;
  photoURL: string | undefined;
  providerData: { providerId: string }[];
}> = {}) => ({
  uid: FIREBASE_UID,
  email: 'joao.silva@enlite.health',
  displayName: 'João Silva',
  photoURL: null,
  providerData: [{ providerId: 'password' }],
  ...overrides,
});

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('GetAdminProfileUseCase', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateLastLogin.mockResolvedValue(undefined);
    mockSetCustomUserClaims.mockResolvedValue(undefined);
    mockFindByEmail.mockResolvedValue(null);
    mockReassignFirebaseUid.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [] });
    mockRelease.mockReset();
    mockConnect.mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cenário 1 — Admin já cadastrado no banco (login normal)', () => {
    it('deve retornar Result.ok com o AdminRecord quando usuário já existe', async () => {
      mockFindByFirebaseUid.mockResolvedValue(mockAdminRecord);

      const useCase = new GetAdminProfileUseCase();
      const result = await useCase.execute(FIREBASE_UID);

      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toEqual(mockAdminRecord);
    });

    it('deve chamar updateLastLogin com o firebaseUid correto', async () => {
      mockFindByFirebaseUid.mockResolvedValue(mockAdminRecord);

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockUpdateLastLogin).toHaveBeenCalledWith(FIREBASE_UID);
      expect(mockUpdateLastLogin).toHaveBeenCalledTimes(1);
    });

    it('não deve chamar admin.auth().getUser quando usuário já existe no banco', async () => {
      mockFindByFirebaseUid.mockResolvedValue(mockAdminRecord);

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('não deve chamar setCustomUserClaims quando usuário já existe no banco', async () => {
      mockFindByFirebaseUid.mockResolvedValue(mockAdminRecord);

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    });

    it('não deve acessar o pool de conexão direta quando usuário já existe no banco', async () => {
      mockFindByFirebaseUid.mockResolvedValue(mockAdminRecord);

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cenário 2 — Novo usuário @enlite.health (auto-provisioning)', () => {
    it('deve retornar Result.ok após auto-provisioning completo', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser());

      const useCase = new GetAdminProfileUseCase();
      const result = await useCase.execute(FIREBASE_UID);

      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toEqual(mockAdminRecord);
    });

    it('deve chamar setCustomUserClaims com { role: "recruiter" } (role padrão para novos @enlite.health)', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser());

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockSetCustomUserClaims).toHaveBeenCalledWith(FIREBASE_UID, { role: 'recruiter' });
    });

    it('auto-provision PRESERVA o claim country da ABAC (bug de QA 16/08: setCustomUserClaims apagava)', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      // O usuário de gate já tinha country=AR gravado pelo script da 3.2 e
      // NENHUMA linha em `users` — exatamente o cenário que apagou o claim.
      mockGetUser.mockResolvedValue({ ...makeFirebaseUser(), customClaims: { role: 'admin', country: 'AR' } });

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockSetCustomUserClaims).toHaveBeenCalledWith(FIREBASE_UID, { role: 'recruiter', country: 'AR' });
    });

    it('deve executar create_user_with_role com os dados corretos do Firebase user', async () => {
      const firebaseUser = makeFirebaseUser({
        email: 'joao.silva@enlite.health',
        displayName: 'João Silva',
        photoURL: 'https://lh3.googleusercontent.com/photo.jpg',
      });
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(firebaseUser);

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT create_user_with_role($1, $2, $3, $4, $5, $6) as data',
        [
          FIREBASE_UID,
          'joao.silva@enlite.health',
          'João Silva',
          'https://lh3.googleusercontent.com/photo.jpg',
          'recruiter',
          JSON.stringify({ department: null }),
        ]
      );
    });

    it('não deve referenciar admins_extension em nenhuma query de provisioning', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser());

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      const extCalls = mockQuery.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('admins_extension')
      );
      expect(extCalls).toHaveLength(0);
    });

    it('deve fazer COMMIT após inserções bem-sucedidas', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser());

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    });

    it('deve chamar findByFirebaseUid duas vezes: antes e após o provisioning', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser());

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockFindByFirebaseUid).toHaveBeenCalledTimes(2);
      expect(mockFindByFirebaseUid).toHaveBeenCalledWith(FIREBASE_UID);
    });

    it('deve liberar o client do pool após o provisioning', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser());

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cenário 3 — Email não é @enlite.health (acesso negado)', () => {
    it('deve retornar Result.fail com "Admin user not found"', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: 'usuario@gmail.com' }));

      const useCase = new GetAdminProfileUseCase();
      const result = await useCase.execute(FIREBASE_UID);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Admin user not found');
    });

    it('não deve chamar setCustomUserClaims para email fora do domínio', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: 'usuario@gmail.com' }));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    });

    it('não deve acessar o pool de conexão para email fora do domínio', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: 'usuario@gmail.com' }));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('não deve chamar updateLastLogin quando acesso é negado', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: 'usuario@outlook.com' }));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockUpdateLastLogin).not.toHaveBeenCalled();
    });

    it('deve negar acesso mesmo para subdomínios parecidos como @sub.enlite.health.br', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: 'usuario@sub.enlite.health.br' }));

      const useCase = new GetAdminProfileUseCase();
      const result = await useCase.execute(FIREBASE_UID);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Admin user not found');
      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cenário 4 — Erro no banco durante auto-provisioning', () => {
    it('deve chamar ROLLBACK quando query falha', async () => {
      const erroDeDB = new Error('duplicate key value violates unique constraint "users_email_key"');
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser());
      // BEGIN passa, create_user_with_role falha
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(erroDeDB);    // create_user_with_role

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('deve retornar Result.fail com a mensagem do erro de DB', async () => {
      const erroDeDB = new Error('connection timeout: could not connect to server');
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser());
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(erroDeDB);

      const useCase = new GetAdminProfileUseCase();
      const result = await useCase.execute(FIREBASE_UID);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('connection timeout: could not connect to server');
    });

    it('deve liberar o client mesmo quando ocorre erro de DB', async () => {
      const erroDeDB = new Error('syntax error at or near "SELECT"');
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser());
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(erroDeDB);

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('não deve chamar COMMIT quando query falha', async () => {
      const erroDeDB = new Error('deadlock detected');
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser());
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(erroDeDB);

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      const commitCalls = mockQuery.mock.calls.filter(
        (args: unknown[]) => args[0] === 'COMMIT'
      );
      expect(commitCalls).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cenário 6 — Reassign de firebase_uid em produção (regressão)', () => {
    // Staff foi convidado via invitation link (provider password, uid_A) e está
    // logando com Google pela primeira vez (uid_B). Sem reassign, o backend
    // tentaria criar nova row e bateria na unique constraint em users.email.
    const UID_PASSWORD = 'firebase-uid-original-password';
    const UID_GOOGLE = 'firebase-uid-google-new';

    const seedRecord: AdminRecord = {
      firebaseUid: UID_PASSWORD,
      email: 'florencia.uberti@enlite.health',
      displayName: 'Florencia Uberti',
      role: 'recruiter',
      department: null,
      lastLoginAt: '2026-05-01T10:00:00.000Z',
      loginCount: 12,
      createdAt: '2026-03-15T10:00:00.000Z',
    };

    const reassignedRecord: AdminRecord = { ...seedRecord, firebaseUid: UID_GOOGLE };

    it('deve fazer reassign quando email já existe sob outro firebase_uid', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)            // lookup inicial pelo uid Google
        .mockResolvedValueOnce(reassignedRecord); // após reassign
      mockGetUser.mockResolvedValue(makeFirebaseUser({
        email: 'florencia.uberti@enlite.health',
        providerData: [{ providerId: 'google.com' }],
      }));
      mockFindByEmail.mockResolvedValue(seedRecord);

      const useCase = new GetAdminProfileUseCase();
      const result = await useCase.execute(UID_GOOGLE);

      expect(mockReassignFirebaseUid).toHaveBeenCalledWith(
        'florencia.uberti@enlite.health',
        UID_GOOGLE
      );
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toEqual(reassignedRecord);
    });

    it('não deve invocar create_user_with_role quando há reassign', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(reassignedRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser({
        email: 'florencia.uberti@enlite.health',
        providerData: [{ providerId: 'google.com' }],
      }));
      mockFindByEmail.mockResolvedValue(seedRecord);

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(UID_GOOGLE);

      const provisionCalls = mockQuery.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('create_user_with_role')
      );
      expect(provisionCalls).toHaveLength(0);
      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    });

    it('não deve reassign se o firebase_uid já é o mesmo (caso degenerado)', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser({
        email: 'florencia.uberti@enlite.health',
      }));
      // findByEmail retorna registro com o MESMO uid que estamos buscando
      mockFindByEmail.mockResolvedValue({ ...seedRecord, firebaseUid: FIREBASE_UID });

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockReassignFirebaseUid).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cenário 5 — Firebase user sem displayName (usa parte do email)', () => {
    it('deve usar email.split("@")[0] como displayName quando displayName é undefined', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser({
        email: 'maria@enlite.health',
        displayName: undefined,
      }));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT create_user_with_role($1, $2, $3, $4, $5, $6) as data',
        expect.arrayContaining([
          FIREBASE_UID,
          'maria@enlite.health',
          'maria', // email.split('@')[0]
        ])
      );
    });

    it('deve usar email.split("@")[0] quando displayName é string vazia', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser({
        email: 'carlos@enlite.health',
        displayName: '',
      }));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT create_user_with_role($1, $2, $3, $4, $5, $6) as data',
        expect.arrayContaining([
          FIREBASE_UID,
          'carlos@enlite.health',
          'carlos',
        ])
      );
    });

    it('deve passar null para photoURL quando photoURL não está definido', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser({
        email: 'ana@enlite.health',
        displayName: 'Ana',
        photoURL: undefined,
      }));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT create_user_with_role($1, $2, $3, $4, $5, $6) as data',
        [
          FIREBASE_UID,
          'ana@enlite.health',
          'Ana',
          null,
          'recruiter',
          JSON.stringify({ department: null }),
        ]
      );
    });
  });

});
