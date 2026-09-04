import { create } from 'zustand';
import { User } from '@domain/entities/User';
import { AdminUser } from '@domain/entities/AdminUser';
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AdminAuthzApiService } from '@infrastructure/http/AdminAuthzApiService';
import type { AuthzContract, AuthzStatus } from '@domain/entities/Authz';
import { AuthTraceHandle } from '@infrastructure/observability/authTrace';

interface AdminAuthState {
  user: User | null;
  adminProfile: AdminUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /**
   * O contrato de autorização do ator (`GET /v1/me/authz`). É a ÚNICA fonte
   * do que a tela mostra: célula ausente → componente ausente. `null` +
   * `authzStatus !== 'ready'` é "ainda não sei", e a UI trata como hidden.
   */
  authz: AuthzContract | null;
  authzStatus: AuthzStatus;

  setUser: (user: User | null) => void;
  setLoading: (isLoading: boolean) => void;
  login: (email: string, password: string, trace?: AuthTraceHandle) => Promise<void>;
  loginWithGoogle: (trace?: AuthTraceHandle) => Promise<void>;
  logout: () => Promise<void>;
  fetchProfile: () => Promise<void>;
  /** Carrega o contrato. Nunca lança: falha vira `authzStatus = 'error'` (fail-closed na tela). */
  fetchAuthz: () => Promise<void>;
  initialize: () => () => void;
}

const authService = new FirebaseAuthService();

export const useAdminAuthStore = create<AdminAuthState>((set, get) => ({
  user: null,
  adminProfile: null,
  isLoading: true,
  isAuthenticated: false,
  authz: null,
  authzStatus: 'idle',

  setUser: (user: User | null): void => set({ user, isAuthenticated: user !== null }),

  setLoading: (isLoading: boolean): void => set({ isLoading }),

  login: async (email: string, password: string, trace?: AuthTraceHandle): Promise<void> => {
    const { user } = await authService.signInWithEmail(email, password);
    trace?.step('firebase-signin:ok', { uid: user.id, email: user.email, provider: 'password' });
    set({ user, isAuthenticated: true });

    try {
      trace?.step('backend-profile:start');
      const profile = await AdminApiService.getProfile();
      trace?.step('backend-profile:ok', { role: profile.role });
      set({ adminProfile: profile });
      await get().fetchAuthz();
    } catch (err) {
      // If profile fetch fails, user might not be admin — mas o trace distingue
      // 404 (realmente não-admin) de 5xx/rede (hiccup transitório).
      trace?.fail('backend-profile', err);
      set({ adminProfile: null });
    }
  },

  loginWithGoogle: async (trace?: AuthTraceHandle): Promise<void> => {
    const { user } = await authService.signInWithGoogle();
    trace?.step('firebase-signin:ok', { uid: user.id, email: user.email, provider: 'google' });

    if (!user.email?.endsWith('@enlite.health')) {
      trace?.step('domain-check:rejected', { email: user.email });
      await authService.logout();
      throw new Error('admin.login.unauthorizedDomain');
    }
    trace?.step('domain-check:ok');

    set({ user, isAuthenticated: true });

    try {
      trace?.step('backend-profile:start');
      const profile = await AdminApiService.getProfile();
      trace?.step('backend-profile:ok', { role: profile.role });
      set({ adminProfile: profile });

      // Force refresh token to pick up custom claims set by backend auto-provisioning
      await authService.forceRefreshToken();
      trace?.step('token-refresh:ok');
      // DEPOIS do refresh: no 1º login o token ainda não tem as claims, e
      // `requireStaff` decide por elas — o contrato viria 403 e a tela nasceria
      // vazia até a próxima troca de área. Achado pelo gate (code-review #4).
      await get().fetchAuthz();
    } catch (err) {
      trace?.fail('backend-profile-or-refresh', err);
      set({ adminProfile: null });
    }
  },

  logout: async (): Promise<void> => {
    await authService.logout();
    set({ user: null, isAuthenticated: false, adminProfile: null, authz: null, authzStatus: 'idle' });
  },

  fetchAuthz: async (): Promise<void> => {
    // Stale-while-revalidate: `AdminLayout` chama isto a cada troca de área.
    // Se JÁ existe um contrato, ele fica valendo — `authzStatus` continua
    // `ready` — até o novo chegar; só descarta se a busca nova realmente
    // decidir algo diferente. Sem isso, `AdminProtectedRoute` via `loading`
    // caía no fallthrough e renderizava o layout com `Outlet` vazio: a tela
    // de boas-vindas sumia e voltava, e o menu piscava em branco (achado real).
    // Só quando NÃO há contrato prévio é que `loading` é honesto.
    const { authz: anterior } = get();
    if (!anterior) set({ authzStatus: 'loading' });
    try {
      const authz = await AdminAuthzApiService.getMyAuthz();
      set({ authz, authzStatus: 'ready' });
    } catch {
      // Sem contrato prévio: a tela não decide nada, e não pode fingir que
      // decidiu — contrato vazio aqui seria lido como "sem grupo" (D114),
      // que é mentira. Com contrato prévio: mantém o antigo — melhor um
      // contrato desatualizado do que a tela virar erro no meio do uso.
      set((state) => (state.authz ? state : { authz: null, authzStatus: 'error' }));
    }
  },

  fetchProfile: async (): Promise<void> => {
    try {
      const profile = await AdminApiService.getProfile();
      set({ adminProfile: profile });
    } catch {
      set({ adminProfile: null });
    }
  },

  initialize: (): (() => void) => {
    const { setUser, setLoading } = get();

    const unsubscribe = authService.onAuthStateChanged(async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          const profile = await AdminApiService.getProfile();
          set({ adminProfile: profile });
          await get().fetchAuthz();
        } catch {
          set({ adminProfile: null });
        }
      }
      setLoading(false);
    });

    return unsubscribe;
  },
}));
