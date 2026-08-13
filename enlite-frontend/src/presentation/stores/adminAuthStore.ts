import { create } from 'zustand';
import { User } from '@domain/entities/User';
import { AdminUser } from '@domain/entities/AdminUser';
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AuthTraceHandle } from '@infrastructure/observability/authTrace';

interface AdminAuthState {
  user: User | null;
  adminProfile: AdminUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;

  setUser: (user: User | null) => void;
  setLoading: (isLoading: boolean) => void;
  login: (email: string, password: string, trace?: AuthTraceHandle) => Promise<void>;
  loginWithGoogle: (trace?: AuthTraceHandle) => Promise<void>;
  logout: () => Promise<void>;
  fetchProfile: () => Promise<void>;
  initialize: () => () => void;
}

const authService = new FirebaseAuthService();

export const useAdminAuthStore = create<AdminAuthState>((set, get) => ({
  user: null,
  adminProfile: null,
  isLoading: true,
  isAuthenticated: false,

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
    } catch (err) {
      trace?.fail('backend-profile-or-refresh', err);
      set({ adminProfile: null });
    }
  },

  logout: async (): Promise<void> => {
    await authService.logout();
    set({ user: null, isAuthenticated: false, adminProfile: null });
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
        } catch {
          set({ adminProfile: null });
        }
      }
      setLoading(false);
    });

    return unsubscribe;
  },
}));
