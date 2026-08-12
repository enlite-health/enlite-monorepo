import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { User } from '@domain/entities/User';

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
    })),
  };
});

vi.mock('@infrastructure/http/WorkerApiService', () => {
  return {
    WorkerApiService: {
      initWorker: vi.fn().mockResolvedValue({ id: 'worker-1' }),
    },
  };
});

// Importações após os mocks para que o store receba as versões mockadas
import { useAuthStore } from '@presentation/stores/authStore';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import type { WorkerProgressResponse, InitWorkerResponse } from '@infrastructure/http/WorkerApiService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockUser = (overrides?: Partial<User>): User => ({
  id: 'firebase-uid-abc123',
  email: 'gabriel.g.stein@gmail.com',
  name: 'Gabriel Stein',
  roles: ['worker'],
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

const resetStore = () => {
  useAuthStore.setState({
    user: null,
    isLoading: true,
    isAuthenticated: false,
  });
};

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('authStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restaura o comportamento padrão do initWorker entre testes.
    // vi.clearAllMocks() zera chamadas mas não restaura implementações mockadas,
    // então um teste que faz mockRejectedValue pode contaminar o próximo,
    // disparando o console.error do catch do loginWithGoogle.
    vi.mocked(WorkerApiService.initWorker).mockResolvedValue({ status: 'ok', worker: { id: 'worker-1' } as WorkerProgressResponse } as InitWorkerResponse);
    resetStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Estado inicial
  // -------------------------------------------------------------------------
  describe('estado inicial', () => {
    it('deve iniciar com user nulo', () => {
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('deve iniciar com isLoading true', () => {
      expect(useAuthStore.getState().isLoading).toBe(true);
    });

    it('deve iniciar com isAuthenticated false', () => {
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('deve ter instância de authService', () => {
      expect(useAuthStore.getState().authService).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // login (email/password) — ERA AQUI O BUG
  // -------------------------------------------------------------------------
  describe('login (email/password)', () => {
    it('deve chamar initWorker após login com email e senha', async () => {
      const mockUser = createMockUser();
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signInWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'token-abc',
      });

      await act(async () => {
        await useAuthStore.getState().login('gabriel.g.stein@gmail.com', 'senha123');
      });

      expect(WorkerApiService.initWorker).toHaveBeenCalledTimes(1);
      expect(WorkerApiService.initWorker).toHaveBeenCalledWith({
        authUid: mockUser.id,
        email: mockUser.email,
      });
    });

    it('deve passar o authUid correto do Firebase para initWorker (não hardcoded, não undefined)', async () => {
      const mockUser = createMockUser({ id: 'uid-gerado-pelo-firebase-xyz' });
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signInWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'token-abc',
      });

      await act(async () => {
        await useAuthStore.getState().login('gabriel.g.stein@gmail.com', 'senha123');
      });

      const chamada = vi.mocked(WorkerApiService.initWorker).mock.calls[0][0];
      expect(chamada.authUid).toBe('uid-gerado-pelo-firebase-xyz');
      expect(chamada.authUid).not.toBeUndefined();
      expect(chamada.authUid).not.toBe('');
    });

    it('não deve bloquear o login se initWorker falhar', async () => {
      const mockUser = createMockUser();
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signInWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'token-abc',
      });
      vi.mocked(WorkerApiService.initWorker).mockRejectedValue(
        new Error('Worker not found'),
      );

      // O login deve resolver sem lançar erro mesmo com initWorker falhando
      await expect(
        act(async () => {
          await useAuthStore.getState().login('gabriel.g.stein@gmail.com', 'senha123');
        }),
      ).resolves.not.toThrow();
    });

    it('deve definir isAuthenticated true e user correto após login', async () => {
      const mockUser = createMockUser();
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signInWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'token-abc',
      });

      await act(async () => {
        await useAuthStore.getState().login('gabriel.g.stein@gmail.com', 'senha123');
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().user).toEqual(mockUser);
    });
  });

  // -------------------------------------------------------------------------
  // loginWithGoogle
  // -------------------------------------------------------------------------
  describe('loginWithGoogle', () => {
    it('deve chamar initWorker após login com Google', async () => {
      const mockUser = createMockUser({ id: 'google-uid-123' });
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });

      await act(async () => {
        await useAuthStore.getState().loginWithGoogle();
      });

      expect(WorkerApiService.initWorker).toHaveBeenCalledTimes(1);
      expect(WorkerApiService.initWorker).toHaveBeenCalledWith({
        authUid: mockUser.id,
        email: mockUser.email,
      });
    });

    it('não deve bloquear o loginWithGoogle se initWorker falhar', async () => {
      const mockUser = createMockUser();
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });
      vi.mocked(WorkerApiService.initWorker).mockRejectedValue(
        new Error('Worker not found'),
      );

      let resultado: User | undefined;
      await act(async () => {
        resultado = await useAuthStore.getState().loginWithGoogle();
      });

      // Deve retornar o user mesmo com initWorker falhando
      expect(resultado).toEqual(mockUser);
    });

    it('deve definir isAuthenticated true e user correto após login com Google', async () => {
      const mockUser = createMockUser({ id: 'google-uid-456' });
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signInWithGoogle).mockResolvedValue({
        user: mockUser,
        idToken: 'google-token',
      });

      await act(async () => {
        await useAuthStore.getState().loginWithGoogle();
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().user).toEqual(mockUser);
    });
  });

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------
  describe('register', () => {
    it('deve chamar initWorker após registro', async () => {
      const mockUser = createMockUser({ id: 'novo-uid-789' });
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signUpWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'new-token',
      });

      await act(async () => {
        await useAuthStore.getState().register('novo@example.com', 'senha456');
      });

      expect(WorkerApiService.initWorker).toHaveBeenCalledTimes(1);
      expect(WorkerApiService.initWorker).toHaveBeenCalledWith({
        authUid: mockUser.id,
        email: mockUser.email,
      });
    });

    it('não deve bloquear o registro se initWorker falhar', async () => {
      const mockUser = createMockUser();
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signUpWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'new-token',
      });
      vi.mocked(WorkerApiService.initWorker).mockRejectedValue(
        new Error('Falha na rede'),
      );

      await expect(
        act(async () => {
          await useAuthStore.getState().register('novo@example.com', 'senha456');
        }),
      ).resolves.not.toThrow();
    });

    it('deve definir isAuthenticated true e user correto após registro', async () => {
      const mockUser = createMockUser({ id: 'novo-uid-reg' });
      const { authService } = useAuthStore.getState();

      vi.mocked(authService.signUpWithEmail).mockResolvedValue({
        user: mockUser,
        idToken: 'new-token',
      });

      await act(async () => {
        await useAuthStore.getState().register('novo@example.com', 'senha456');
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().user).toEqual(mockUser);
    });
  });

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------
  describe('logout', () => {
    it('deve limpar user e isAuthenticated após logout', async () => {
      const { authService } = useAuthStore.getState();
      vi.mocked(authService.logout).mockResolvedValue(undefined);

      // Garante estado autenticado antes do logout
      act(() => {
        useAuthStore.setState({ user: createMockUser(), isAuthenticated: true });
      });

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('NÃO deve chamar initWorker no logout', async () => {
      const { authService } = useAuthStore.getState();
      vi.mocked(authService.logout).mockResolvedValue(undefined);

      act(() => {
        useAuthStore.setState({ user: createMockUser(), isAuthenticated: true });
      });

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      expect(WorkerApiService.initWorker).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Contrato crítico — evita regressão do bug
  // -------------------------------------------------------------------------
  describe('contrato crítico: todos os métodos de autenticação chamam initWorker', () => {
    it.each([
      {
        metodo: 'login',
        exec: async (user: User) => {
          const { authService } = useAuthStore.getState();
          vi.mocked(authService.signInWithEmail).mockResolvedValue({
            user,
            idToken: 'token',
          });
          await useAuthStore.getState().login('email@test.com', 'senha');
        },
      },
      {
        metodo: 'loginWithGoogle',
        exec: async (user: User) => {
          const { authService } = useAuthStore.getState();
          vi.mocked(authService.signInWithGoogle).mockResolvedValue({
            user,
            idToken: 'token',
          });
          await useAuthStore.getState().loginWithGoogle();
        },
      },
      {
        metodo: 'register',
        exec: async (user: User) => {
          const { authService } = useAuthStore.getState();
          vi.mocked(authService.signUpWithEmail).mockResolvedValue({
            user,
            idToken: 'token',
          });
          await useAuthStore.getState().register('email@test.com', 'senha');
        },
      },
    ])(
      '$metodo deve chamar initWorker com authUid e email do usuário autenticado',
      async ({ exec }) => {
        const mockUser = createMockUser({ id: 'uid-contrato-critico' });

        await act(async () => {
          await exec(mockUser);
        });

        expect(WorkerApiService.initWorker).toHaveBeenCalledTimes(1);
        expect(WorkerApiService.initWorker).toHaveBeenCalledWith(
          expect.objectContaining({
            authUid: 'uid-contrato-critico',
            email: mockUser.email,
          }),
        );
      },
    );
  });

  // -------------------------------------------------------------------------
  // Testes de estado existentes (mantidos para não regredir)
  // -------------------------------------------------------------------------
  describe('setUser', () => {
    it('deve definir user', () => {
      const user = createMockUser();

      act(() => {
        useAuthStore.getState().setUser(user);
      });

      expect(useAuthStore.getState().user).toEqual(user);
    });

    it('deve permitir definir user como null', () => {
      act(() => {
        useAuthStore.getState().setUser(createMockUser());
        useAuthStore.getState().setUser(null);
      });

      expect(useAuthStore.getState().user).toBeNull();
    });

    it('deve atualizar isAuthenticated quando user é definido', () => {
      act(() => {
        useAuthStore.getState().setUser(createMockUser());
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('deve atualizar isAuthenticated para false quando user é null', () => {
      act(() => {
        useAuthStore.getState().setUser(createMockUser());
        useAuthStore.getState().setUser(null);
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('setLoading', () => {
    it('deve atualizar isLoading', () => {
      act(() => {
        useAuthStore.getState().setLoading(false);
      });

      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('deve alternar isLoading', () => {
      act(() => {
        useAuthStore.getState().setLoading(false);
        useAuthStore.getState().setLoading(true);
      });

      expect(useAuthStore.getState().isLoading).toBe(true);
    });
  });

  describe('initialize (listener de auth state)', () => {
    it('deve registrar listener e retornar função de cancelamento', () => {
      const { authService } = useAuthStore.getState();
      vi.mocked(authService.onAuthStateChanged).mockReturnValue(() => {});

      const cancelar = useAuthStore.getState().initialize();

      expect(authService.onAuthStateChanged).toHaveBeenCalled();
      expect(typeof cancelar).toBe('function');
    });

    it('deve atualizar state quando o auth state muda', () => {
      const mockUser = createMockUser();
      const { authService } = useAuthStore.getState();

      let callback: ((user: User | null) => void) | null = null;
      vi.mocked(authService.onAuthStateChanged).mockImplementation(
        (cb: (user: User | null) => void) => {
          callback = cb;
          return () => {};
        },
      );

      useAuthStore.getState().initialize();

      act(() => {
        callback?.(mockUser);
      });

      expect(useAuthStore.getState().user).toEqual(mockUser);
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('deve limpar user quando o listener emite null (sign out externo)', () => {
      const { authService } = useAuthStore.getState();

      let callback: ((user: User | null) => void) | null = null;
      vi.mocked(authService.onAuthStateChanged).mockImplementation(
        (cb: (user: User | null) => void) => {
          callback = cb;
          return () => {};
        },
      );

      act(() => {
        useAuthStore.setState({ user: createMockUser(), isAuthenticated: true });
      });

      useAuthStore.getState().initialize();

      act(() => {
        callback?.(null);
      });

      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  describe('propagação de erros de autenticação', () => {
    it('deve propagar erro quando signInWithEmail falha', async () => {
      const { authService } = useAuthStore.getState();
      vi.mocked(authService.signInWithEmail).mockRejectedValue(
        new Error('Credenciais inválidas'),
      );

      await expect(
        useAuthStore.getState().login('test@test.com', 'errado'),
      ).rejects.toThrow('Credenciais inválidas');
    });

    it('deve propagar erro quando signUpWithEmail falha', async () => {
      const { authService } = useAuthStore.getState();
      vi.mocked(authService.signUpWithEmail).mockRejectedValue(
        new Error('Email já cadastrado'),
      );

      await expect(
        useAuthStore.getState().register('existente@test.com', 'senha'),
      ).rejects.toThrow('Email já cadastrado');
    });
  });
});
