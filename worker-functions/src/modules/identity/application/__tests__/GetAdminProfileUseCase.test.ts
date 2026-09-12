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

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

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
      // 07/09: `role` sai do contrato — o perfil que o painel recebe é o registro SEM o papel.
      const { role: _role, ...semPapel } = mockAdminRecord;
      expect(result.getValue()).toEqual(semPapel);
      expect(result.getValue()).not.toHaveProperty('role');
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
      // 07/09: `role` sai do contrato — o perfil que o painel recebe é o registro SEM o papel.
      const { role: _role, ...semPapel } = mockAdminRecord;
      expect(result.getValue()).toEqual(semPapel);
      expect(result.getValue()).not.toHaveProperty('role');
    });

    it('deve chamar setCustomUserClaims com { role: "recruiter" } (role padrão para novos @enlite.health)', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockAdminRecord);
      mockGetUser.mockResolvedValue(makeFirebaseUser());

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      // D294 (lex C8): SÓ `account_type` entra junto do papel — nenhum outro campo.
      expect(mockSetCustomUserClaims).toHaveBeenCalledWith(FIREBASE_UID, { role: 'recruiter', account_type: 'staff' });
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

      expect(mockSetCustomUserClaims).toHaveBeenCalledWith(FIREBASE_UID, { role: 'recruiter', account_type: 'staff', country: 'AR' });
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
      const { role: _role, ...semPapel } = reassignedRecord;
      expect(result.getValue()).toEqual(semPapel);
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


  // ─────────────────────────────────────────────────────────────────────────────
  describe('Ramos residuais (07/09 — o arquivo tocado fecha em 100%)', () => {
    it('erro que não é Error no getProfile vira a mensagem genérica', async () => {
      mockFindByFirebaseUid.mockRejectedValue('string crua');
      const result = await new GetAdminProfileUseCase().execute(FIREBASE_UID);
      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Failed to get admin profile');
    });

    it('usuário Firebase sem e-mail e sem provedores é rejeitado sem tocar no banco', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({ ...makeFirebaseUser(), email: undefined, providerData: [] });
      const result = await new GetAdminProfileUseCase().execute(FIREBASE_UID);
      expect(result.isFailure).toBe(true);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('reassign de firebase_uid que não recarrega a linha devolve "not found" (nunca inventa perfil)', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser());
      mockFindByEmail.mockResolvedValue({ ...mockAdminRecord, firebaseUid: 'uid-antigo' });
      const result = await new GetAdminProfileUseCase().execute(FIREBASE_UID);
      expect(mockReassignFirebaseUid).toHaveBeenCalledWith('joao.silva@enlite.health', FIREBASE_UID);
      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Admin user not found');
    });

    it('ROLLBACK falhando (Error e não-Error) é reportado, e o erro ORIGINAL do provisioning é o devolvido', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser());
      mockQuery
        .mockResolvedValueOnce({ rows: [] })            // BEGIN
        .mockRejectedValueOnce('provision string')       // create_user_with_role (não-Error)
        .mockRejectedValueOnce(new Error('rollback morreu')); // ROLLBACK
      let result = await new GetAdminProfileUseCase().execute(FIREBASE_UID);
      // não-Error relançado chega ao `catch` de cima como mensagem genérica
      expect(result.error).toBe('Failed to get admin profile');
      expect((mockReportError.mock.calls[0][0] as Error).message).toBe('rollback morreu');
      expect(mockReportError.mock.calls[0][1]).toEqual({ source: 'GetAdminProfileUseCase:rollback' });

      mockReportError.mockReset();
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('duplicate key'))
        .mockRejectedValueOnce('rollback string');
      result = await new GetAdminProfileUseCase().execute(FIREBASE_UID);
      expect(result.error).toBe('duplicate key');
      expect((mockReportError.mock.calls[0][0] as Error).message).toBe('rollback string');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────

  describe('PII — e-mail de staff nunca aparece cru em log (gate revisao-pr, 12/09)', () => {
    // Local-part sentinela, improvável de aparecer por acaso em qualquer outro
    // valor logado (role, uid, msg) — se aparecer capturado, é vazamento.
    const SENSITIVE_LOCAL_PART = 'zzsentinela-nao-pode-vazar';
    const SENSITIVE_EMAIL = `${SENSITIVE_LOCAL_PART}@enlite.health`;

    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    const capturedOutput = () =>
      [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.join(' '))
        .join('\n');

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('lookup hit: loga uid+role, NUNCA o e-mail (nem cru nem mascarado)', async () => {
      mockFindByFirebaseUid.mockResolvedValue({ ...mockAdminRecord, email: SENSITIVE_EMAIL });

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      const out = capturedOutput();
      expect(out).not.toContain(SENSITIVE_LOCAL_PART);
      expect(out).not.toContain(SENSITIVE_EMAIL);
      expect(out).toContain(`uid=${FIREBASE_UID}`);
    });

    it('auto-provision ok / provision committed: loga uid, NUNCA o e-mail cru', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...mockAdminRecord, email: SENSITIVE_EMAIL });
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: SENSITIVE_EMAIL }));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      const out = capturedOutput();
      expect(out).not.toContain(SENSITIVE_LOCAL_PART);
      // "firebase user resolved" e "auto-provision rejected" usam maskEmailForLog
      // — domínio pode aparecer, local-part nunca.
      expect(out).toContain('***@enlite.health');
      expect(out).toContain(`uid=${FIREBASE_UID}`);
    });

    it('email fora do domínio: log de rejeição mostra domínio mascarado, não o local-part', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: `${SENSITIVE_LOCAL_PART}@gmail.com` }));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      const out = capturedOutput();
      expect(out).not.toContain(SENSITIVE_LOCAL_PART);
      expect(out).toContain('***@gmail.com');
    });

    it('reassign de firebase_uid: loga old/new uid, NUNCA o e-mail cru', async () => {
      mockFindByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...mockAdminRecord, email: SENSITIVE_EMAIL, firebaseUid: FIREBASE_UID });
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: SENSITIVE_EMAIL }));
      mockFindByEmail.mockResolvedValue({ ...mockAdminRecord, email: SENSITIVE_EMAIL, firebaseUid: 'old-uid-xyz' });

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      const out = capturedOutput();
      expect(out).not.toContain(SENSITIVE_LOCAL_PART);
      expect(out).toContain('old=old-uid-xyz');
      expect(out).toContain(`new=${FIREBASE_UID}`);
    });

    it('erro de DB durante provisioning: log de falha mostra uid, NUNCA o e-mail cru', async () => {
      mockFindByFirebaseUid.mockResolvedValue(null);
      mockGetUser.mockResolvedValue(makeFirebaseUser({ email: SENSITIVE_EMAIL }));
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error('db down'));

      const useCase = new GetAdminProfileUseCase();
      await useCase.execute(FIREBASE_UID);

      const out = capturedOutput();
      expect(out).not.toContain(SENSITIVE_LOCAL_PART);
      expect(out).toContain(`provision failed | uid=${FIREBASE_UID}`);
    });
  });

});
