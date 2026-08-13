import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { User } from '@domain/entities/User';
import { AdminUser } from '@domain/entities/AdminUser';
import { EnliteRole } from '@domain/entities/EnliteRole';

// ---------------------------------------------------------------------------
// Mocks — devem vir antes de qualquer importação que dependa deles
// ---------------------------------------------------------------------------

vi.mock('@infrastructure/services/FirebaseAuthService', () => {
  return {
    FirebaseAuthService: vi.fn().mockImplementation(() => ({
      signInWithEmail: vi.fn(),
      signInWithGoogle: vi.fn(),
      signUpWithEmail: vi.fn(),
      logout: vi.fn(),
      onAuthStateChanged: vi.fn(),
      getIdToken: vi.fn(),
      forceRefreshToken: vi.fn().mockResolvedValue('refreshed-token'),
    })),
  };
});

vi.mock('@infrastructure/http/AdminApiService', () => {
  return {
    AdminApiService: {
      getProfile: vi.fn(),
    },
  };
});

vi.mock('@infrastructure/http/WorkerApiService', () => {
  return {
    WorkerApiService: {
      initWorker: vi.fn().mockResolvedValue({ id: 'worker-1' }),
    },
  };
});

// Importações após os mocks para que os stores recebam as versões mockadas
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAuthStore } from '@presentation/stores/authStore';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError } from '@infrastructure/http/ApiError';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockUser = (overrides?: Partial<User>): User => ({
  id: 'firebase-uid-abc123',
  email: 'admin@enlite.health',
  name: 'Admin Enlite',
  roles: ['admin'],
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

const createMockAdminUser = (overrides?: Partial<AdminUser>): AdminUser => ({
  firebaseUid: 'firebase-uid-abc123',
  email: 'admin@enlite.health',
  displayName: 'Admin Enlite',
  role: EnliteRole.ADMIN,
  department: 'Tecnologia',
  lastLoginAt: '2024-06-01T10:00:00Z',
  loginCount: 5,
  createdAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

// Captura a instância do FirebaseAuthService criada pelo adminAuthStore no
// momento da importação do módulo — ANTES de qualquer clearAllMocks.
const adminAuthServiceInstance = vi.mocked(FirebaseAuthService).mock.results[0]?.value as {
  signInWithEmail: ReturnType<typeof vi.fn>;
  signInWithGoogle: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  onAuthStateChanged: ReturnType<typeof vi.fn>;
  forceRefreshToken: ReturnType<typeof vi.fn>;
  getIdToken: ReturnType<typeof vi.fn>;
};

const resetAdminStore = () => {
  useAdminAuthStore.setState({
    user: null,
    adminProfile: null,
    isLoading: true,
    isAuthenticated: false,
  });
};

const resetWorkerStore = () => {
  useAuthStore.setState({
    user: null,
    isLoading: true,
    isAuthenticated: false,
  });
};

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('adminAuthStore', () => {
  beforeEach(() => {
    // Reseta retornos dos mocks sem limpar .mock.results (preserva instâncias)
    adminAuthServiceInstance.signInWithEmail.mockReset();
    adminAuthServiceInstance.signInWithGoogle.mockReset();
    adminAuthServiceInstance.logout.mockReset();
    adminAuthServiceInstance.onAuthStateChanged.mockReset();
    adminAuthServiceInstance.forceRefreshToken.mockReset().mockResolvedValue('refreshed-token');
    adminAuthServiceInstance.getIdToken.mockReset();
    vi.mocked(AdminApiService.getProfile).mockReset();
    resetAdminStore();
    resetWorkerStore();
  });

  // -------------------------------------------------------------------------
  // Cenário 1 — Estado inicial
  // -------------------------------------------------------------------------
  describe('estado inicial', () => {
    it('deve iniciar com user nulo', () => {
      expect(useAdminAuthStore.getState().user).toBeNull();
    });

    it('deve iniciar com adminProfile nulo', () => {
      expect(useAdminAuthStore.getState().adminProfile).toBeNull();
    });

    it('deve iniciar com isLoading true', () => {
      expect(useAdminAuthStore.getState().isLoading).toBe(true);
    });

    it('deve iniciar com isAuthenticated false', () => {
      expect(useAdminAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cenário 2 — Login Google com @enlite.health SEM cadastro (auto-provisioning)
  // -------------------------------------------------------------------------
  describe('loginWithGoogle — email @enlite.health sem cadastro prévio (auto-provisioning)', () => {
    it('deve setar user e isAuthenticated true após login bem-sucedido', async () => {
      const mockUser = createMockUser({ email: 'admin@enlite.health' });
      const mockProfile = createMockAdminUser();

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle();
      });

      expect(useAdminAuthStore.getState().user).toEqual(mockUser);
      expect(useAdminAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('deve setar adminProfile com dados retornados pelo backend', async () => {
      const mockUser = createMockUser({ email: 'admin@enlite.health' });
      const mockProfile = createMockAdminUser({ loginCount: 1 });

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle();
      });

      expect(useAdminAuthStore.getState().adminProfile).toEqual(mockProfile);
    });

    it('deve chamar forceRefreshToken para atualizar claims do auto-provisioning', async () => {
      const mockUser = createMockUser({ email: 'admin@enlite.health' });
      const mockProfile = createMockAdminUser();

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle();
      });

      expect(adminAuthServiceInstance.forceRefreshToken).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Cenário 3 — Login Google com @enlite.health já cadastrado na base
  // -------------------------------------------------------------------------
  describe('loginWithGoogle — email @enlite.health já cadastrado', () => {
    it('deve setar adminProfile com loginCount correto', async () => {
      const mockUser = createMockUser({ email: 'admin@enlite.health' });
      const mockProfile = createMockAdminUser({ loginCount: 5 });

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle();
      });

      expect(useAdminAuthStore.getState().adminProfile?.loginCount).toBe(5);
    });

    it('deve chamar forceRefreshToken mesmo para usuário já cadastrado', async () => {
      const mockUser = createMockUser({ email: 'admin@enlite.health' });
      const mockProfile = createMockAdminUser({ loginCount: 5 });

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle();
      });

      expect(adminAuthServiceInstance.forceRefreshToken).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Cenário 4 — Login Google com email NÃO @enlite.health (bloqueado)
  // -------------------------------------------------------------------------
  describe('loginWithGoogle — email fora do domínio @enlite.health (bloqueado)', () => {
    it('deve lançar erro com mensagem admin.login.unauthorizedDomain', async () => {
      const mockUser = createMockUser({ email: 'usuario@gmail.com' });

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });

      await expect(
        act(async () => {
          await useAdminAuthStore.getState().loginWithGoogle();
        }),
      ).rejects.toThrow('admin.login.unauthorizedDomain');
    });

    it('deve chamar authService.logout para deslogar do Firebase após domínio inválido', async () => {
      const mockUser = createMockUser({ email: 'usuario@gmail.com' });

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(adminAuthServiceInstance.logout).mockResolvedValue(undefined);

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle().catch(() => undefined);
      });

      expect(adminAuthServiceInstance.logout).toHaveBeenCalledTimes(1);
    });

    it('não deve chamar getProfile quando domínio é inválido', async () => {
      const mockUser = createMockUser({ email: 'usuario@gmail.com' });

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(adminAuthServiceInstance.logout).mockResolvedValue(undefined);

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle().catch(() => undefined);
      });

      expect(AdminApiService.getProfile).not.toHaveBeenCalled();
    });

    it('deve manter adminProfile nulo após tentativa com domínio inválido', async () => {
      const mockUser = createMockUser({ email: 'usuario@gmail.com' });

      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(adminAuthServiceInstance.logout).mockResolvedValue(undefined);

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle().catch(() => undefined);
      });

      expect(useAdminAuthStore.getState().adminProfile).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Cenário 5 — Login email/password fluxo normal admin
  // -------------------------------------------------------------------------
  describe('login (email/password) — fluxo normal admin', () => {
    it('deve setar user, isAuthenticated e adminProfile corretamente', async () => {
      const mockUser = createMockUser();
      const mockProfile = createMockAdminUser();

      vi.mocked(adminAuthServiceInstance.signInWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'token-abc',
      });
      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);

      await act(async () => {
        await useAdminAuthStore.getState().login('admin@enlite.health', 'senha123');
      });

      expect(useAdminAuthStore.getState().user).toEqual(mockUser);
      expect(useAdminAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAdminAuthStore.getState().adminProfile).toEqual(mockProfile);
    });

    it('deve propagar erro quando signInWithEmail falha', async () => {
      vi.mocked(adminAuthServiceInstance.signInWithEmail).mockRejectedValue(
        new Error('Credenciais inválidas'),
      );

      await expect(
        useAdminAuthStore.getState().login('admin@enlite.health', 'senha-errada'),
      ).rejects.toThrow('Credenciais inválidas');
    });
  });

  // -------------------------------------------------------------------------
  // Cenário 6 — Login email/password quando profile fetch falha
  // -------------------------------------------------------------------------
  describe('login (email/password) — profile fetch falha (usuário não é admin na base)', () => {
    it('deve manter isAuthenticated true (login no Firebase foi bem-sucedido)', async () => {
      const mockUser = createMockUser();

      vi.mocked(adminAuthServiceInstance.signInWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'token-abc',
      });
      vi.mocked(AdminApiService.getProfile).mockRejectedValue(new Error('Forbidden'));

      await act(async () => {
        await useAdminAuthStore.getState().login('admin@enlite.health', 'senha123');
      });

      expect(useAdminAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('deve setar adminProfile como null quando getProfile lança erro', async () => {
      const mockUser = createMockUser();

      vi.mocked(adminAuthServiceInstance.signInWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'token-abc',
      });
      vi.mocked(AdminApiService.getProfile).mockRejectedValue(new Error('Forbidden'));

      await act(async () => {
        await useAdminAuthStore.getState().login('admin@enlite.health', 'senha123');
      });

      expect(useAdminAuthStore.getState().adminProfile).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Cenário 7 — Logout limpa todo o state
  // -------------------------------------------------------------------------
  describe('logout', () => {
    it('deve limpar user após logout', async () => {
      vi.mocked(adminAuthServiceInstance.logout).mockResolvedValue(undefined);

      act(() => {
        useAdminAuthStore.setState({
          user: createMockUser(),
          adminProfile: createMockAdminUser(),
          isAuthenticated: true,
        });
      });

      await act(async () => {
        await useAdminAuthStore.getState().logout();
      });

      expect(useAdminAuthStore.getState().user).toBeNull();
    });

    it('deve limpar adminProfile após logout', async () => {
      vi.mocked(adminAuthServiceInstance.logout).mockResolvedValue(undefined);

      act(() => {
        useAdminAuthStore.setState({
          user: createMockUser(),
          adminProfile: createMockAdminUser(),
          isAuthenticated: true,
        });
      });

      await act(async () => {
        await useAdminAuthStore.getState().logout();
      });

      expect(useAdminAuthStore.getState().adminProfile).toBeNull();
    });

    it('deve setar isAuthenticated false após logout', async () => {
      vi.mocked(adminAuthServiceInstance.logout).mockResolvedValue(undefined);

      act(() => {
        useAdminAuthStore.setState({
          user: createMockUser(),
          adminProfile: createMockAdminUser(),
          isAuthenticated: true,
        });
      });

      await act(async () => {
        await useAdminAuthStore.getState().logout();
      });

      expect(useAdminAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('deve chamar authService.logout uma vez', async () => {
      vi.mocked(adminAuthServiceInstance.logout).mockResolvedValue(undefined);

      act(() => {
        useAdminAuthStore.setState({ user: createMockUser(), isAuthenticated: true });
      });

      await act(async () => {
        await useAdminAuthStore.getState().logout();
      });

      expect(adminAuthServiceInstance.logout).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Cenário 8 — Admin @enlite.health no fluxo worker não afeta adminAuthStore
  // -------------------------------------------------------------------------
  describe('isolamento de stores — admin no fluxo worker não afeta adminAuthStore', () => {
    // O authStore expõe authService no state — usamos diretamente.
    const getWorkerAuthService = () => useAuthStore.getState().authService;

    it('deve permitir login no authStore (worker) com email @enlite.health', async () => {
      const mockAdminAsWorker = createMockUser({
        id: 'admin-firebase-uid',
        email: 'admin@enlite.health',
        roles: ['worker'],
      });

      vi.mocked(getWorkerAuthService().signInWithGoogle).mockResolvedValue({
        user: mockAdminAsWorker,
        idToken: 'google-token-worker',
      });

      await act(async () => {
        await useAuthStore.getState().loginWithGoogle();
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('deve manter adminProfile nulo no adminAuthStore quando login ocorre apenas no authStore', async () => {
      const mockAdminAsWorker = createMockUser({
        id: 'admin-firebase-uid',
        email: 'admin@enlite.health',
        roles: ['worker'],
      });

      vi.mocked(getWorkerAuthService().signInWithGoogle).mockResolvedValue({
        user: mockAdminAsWorker,
        idToken: 'google-token-worker',
      });

      await act(async () => {
        await useAuthStore.getState().loginWithGoogle();
      });

      expect(useAdminAuthStore.getState().adminProfile).toBeNull();
    });

    it('deve manter isAuthenticated false no adminAuthStore quando login ocorre apenas no authStore', async () => {
      const mockAdminAsWorker = createMockUser({
        id: 'admin-firebase-uid',
        email: 'admin@enlite.health',
        roles: ['worker'],
      });

      vi.mocked(getWorkerAuthService().signInWithGoogle).mockResolvedValue({
        user: mockAdminAsWorker,
        idToken: 'google-token-worker',
      });

      await act(async () => {
        await useAuthStore.getState().loginWithGoogle();
      });

      expect(useAdminAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // fetchProfile
  // -------------------------------------------------------------------------
  describe('fetchProfile', () => {
    it('deve atualizar adminProfile quando fetch é bem-sucedido', async () => {
      const mockProfile = createMockAdminUser({ loginCount: 10 });
      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);

      await act(async () => {
        await useAdminAuthStore.getState().fetchProfile();
      });

      expect(useAdminAuthStore.getState().adminProfile).toEqual(mockProfile);
    });

    it('deve setar adminProfile como null quando getProfile lança erro', async () => {
      vi.mocked(AdminApiService.getProfile).mockRejectedValue(new Error('Unauthorized'));

      act(() => {
        useAdminAuthStore.setState({ adminProfile: createMockAdminUser() });
      });

      await act(async () => {
        await useAdminAuthStore.getState().fetchProfile();
      });

      expect(useAdminAuthStore.getState().adminProfile).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // setUser e setLoading
  // -------------------------------------------------------------------------
  describe('setUser', () => {
    it('deve definir user e atualizar isAuthenticated para true', () => {
      const user = createMockUser();

      act(() => {
        useAdminAuthStore.getState().setUser(user);
      });

      expect(useAdminAuthStore.getState().user).toEqual(user);
      expect(useAdminAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('deve permitir definir user como null e setar isAuthenticated false', () => {
      act(() => {
        useAdminAuthStore.getState().setUser(createMockUser());
        useAdminAuthStore.getState().setUser(null);
      });

      expect(useAdminAuthStore.getState().user).toBeNull();
      expect(useAdminAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('setLoading', () => {
    it('deve atualizar isLoading para false', () => {
      act(() => {
        useAdminAuthStore.getState().setLoading(false);
      });

      expect(useAdminAuthStore.getState().isLoading).toBe(false);
    });

    it('deve alternar isLoading', () => {
      act(() => {
        useAdminAuthStore.getState().setLoading(false);
        useAdminAuthStore.getState().setLoading(true);
      });

      expect(useAdminAuthStore.getState().isLoading).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // initialize (listener de auth state)
  // -------------------------------------------------------------------------
  describe('initialize (listener de auth state)', () => {
    it('deve registrar listener e retornar função de cancelamento', () => {
      vi.mocked(adminAuthServiceInstance.onAuthStateChanged).mockReturnValue(() => {});

      const cancelar = useAdminAuthStore.getState().initialize();

      expect(adminAuthServiceInstance.onAuthStateChanged).toHaveBeenCalled();
      expect(typeof cancelar).toBe('function');
    });

    it('deve buscar adminProfile quando listener emite usuário autenticado', async () => {
      const mockUser = createMockUser({ email: 'admin@enlite.health' });
      const mockProfile = createMockAdminUser();

      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);

      let callback: ((user: User | null) => Promise<void>) | null = null;
      vi.mocked(adminAuthServiceInstance.onAuthStateChanged).mockImplementation(
        (cb: (user: User | null) => Promise<void>) => {
          callback = cb;
          return () => {};
        },
      );

      useAdminAuthStore.getState().initialize();

      await act(async () => {
        await callback?.(mockUser);
      });

      expect(useAdminAuthStore.getState().adminProfile).toEqual(mockProfile);
      expect(useAdminAuthStore.getState().isLoading).toBe(false);
    });

    it('deve limpar user e setar isLoading false quando listener emite null (sign out externo)', async () => {
      let callback: ((user: User | null) => Promise<void>) | null = null;
      vi.mocked(adminAuthServiceInstance.onAuthStateChanged).mockImplementation(
        (cb: (user: User | null) => Promise<void>) => {
          callback = cb;
          return () => {};
        },
      );

      act(() => {
        useAdminAuthStore.setState({ user: createMockUser(), isAuthenticated: true });
      });

      useAdminAuthStore.getState().initialize();

      await act(async () => {
        await callback?.(null);
      });

      expect(useAdminAuthStore.getState().user).toBeNull();
      expect(useAdminAuthStore.getState().isLoading).toBe(false);
    });

    it('deve setar adminProfile null quando getProfile falha no listener', async () => {
      const mockUser = createMockUser({ email: 'admin@enlite.health' });

      vi.mocked(AdminApiService.getProfile).mockRejectedValue(new Error('Unauthorized'));

      let callback: ((user: User | null) => Promise<void>) | null = null;
      vi.mocked(adminAuthServiceInstance.onAuthStateChanged).mockImplementation(
        (cb: (user: User | null) => Promise<void>) => {
          callback = cb;
          return () => {};
        },
      );

      useAdminAuthStore.getState().initialize();

      await act(async () => {
        await callback?.(mockUser);
      });

      expect(useAdminAuthStore.getState().adminProfile).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Rastreabilidade — o store alimenta o AuthTraceHandle passado pela page
  // -------------------------------------------------------------------------
  describe('rastreabilidade do login (trace)', () => {
    const makeTrace = () => ({
      id: 'login-test',
      step: vi.fn(),
      fail: vi.fn(),
      end: vi.fn(),
    });

    it('loginWithGoogle registra as etapas até o backend-profile:ok', async () => {
      const mockUser = createMockUser({ email: 'admin@enlite.health' });
      const mockProfile = createMockAdminUser();
      vi.mocked(adminAuthServiceInstance.signInWithGoogle).mockResolvedValue({ user: mockUser, idToken: 'google-token' });
      vi.mocked(AdminApiService.getProfile).mockResolvedValue(mockProfile);
      const trace = makeTrace();

      await act(async () => {
        await useAdminAuthStore.getState().loginWithGoogle(trace);
      });

      const steps = trace.step.mock.calls.map((c) => c[0]);
      expect(steps).toEqual(expect.arrayContaining([
        'firebase-signin:ok', 'domain-check:ok', 'backend-profile:start', 'backend-profile:ok', 'token-refresh:ok',
      ]));
      expect(trace.fail).not.toHaveBeenCalled();
    });

    it('login captura o 404 (não-admin) via trace.fail com o status HTTP', async () => {
      const mockUser = createMockUser({ email: 'javiertest2027@gmail.com' });
      vi.mocked(adminAuthServiceInstance.signInWithEmail).mockResolvedValue({ user: mockUser, idToken: 'tok' });
      vi.mocked(AdminApiService.getProfile).mockRejectedValue(
        new ApiError({ success: false, error: 'Admin user not found' }, 404),
      );
      const trace = makeTrace();

      await act(async () => {
        await useAdminAuthStore.getState().login('javiertest2027@gmail.com', 'pw', trace);
      });

      expect(useAdminAuthStore.getState().adminProfile).toBeNull();
      expect(trace.fail).toHaveBeenCalledWith('backend-profile', expect.objectContaining({ status: 404 }));
    });
  });
});
