import { useEffect } from 'react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { User } from '@domain/entities/User';
import { AdminUser } from '@domain/entities/AdminUser';
import { AuthTraceHandle } from '@infrastructure/observability/authTrace';

interface UseAdminAuthReturn {
  user: User | null;
  adminProfile: AdminUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string, trace?: AuthTraceHandle) => Promise<void>;
  loginWithGoogle: (trace?: AuthTraceHandle) => Promise<void>;
  logout: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

export function useAdminAuth(): UseAdminAuthReturn {
  const user = useAdminAuthStore((s) => s.user);
  const adminProfile = useAdminAuthStore((s) => s.adminProfile);
  const isAuthenticated = useAdminAuthStore((s) => s.isAuthenticated);
  const isLoading = useAdminAuthStore((s) => s.isLoading);
  const login = useAdminAuthStore((s) => s.login);
  const loginWithGoogle = useAdminAuthStore((s) => s.loginWithGoogle);
  const logout = useAdminAuthStore((s) => s.logout);
  const fetchProfile = useAdminAuthStore((s) => s.fetchProfile);
  const initialize = useAdminAuthStore((s) => s.initialize);

  useEffect(() => {
    console.log('[useAdminAuth] Inicializando auth...');
    const unsubscribe = initialize();
    return () => {
      console.log('[useAdminAuth] Limpando subscription');
      unsubscribe();
    };
  }, [initialize]);

  useEffect(() => {
    console.log('[useAdminAuth] Estado atualizado:', { isAuthenticated, isLoading, hasProfile: !!adminProfile });
  }, [isAuthenticated, isLoading, adminProfile]);

  return {
    user,
    adminProfile,
    isAuthenticated,
    isLoading,
    login,
    loginWithGoogle,
    logout,
    fetchProfile,
  };
}
