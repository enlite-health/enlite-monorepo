import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { shouldShowWelcomeNoGroup, welcomeNoGroupReason } from '@domain/entities/Authz';
import { WelcomeNoGroupPage } from '@presentation/pages/admin/WelcomeNoGroupPage';

interface AdminProtectedRouteProps {
  children: ReactNode;
}

/**
 * Ponto ÚNICO de condicionamento da A1 (D268): esta rota envolve `<AdminLayout>`
 * na raiz de `/admin` (App.tsx), e TODA rota `/admin/*` é filha dele via
 * `Outlet` — então checar aqui, uma vez, cobre a família inteira sem duplicar
 * o gate em cada página. `loading`/`error` do authz caem no fallthrough
 * (renderizam `children` como sempre — a postura de cada um já existe em
 * outro lugar, ex. `AccessGate`; ver tabela-verdade em `Authz.test.ts`).
 */
export function AdminProtectedRoute({ children }: AdminProtectedRouteProps) {
  const { isAuthenticated, isLoading, adminProfile } = useAdminAuth();
  const authz = useAdminAuthStore((s) => s.authz);
  const authzStatus = useAdminAuthStore((s) => s.authzStatus);

  console.log('[AdminProtectedRoute] Estado:', { isAuthenticated, isLoading, hasProfile: !!adminProfile });

  if (isLoading) {
    console.log('[AdminProtectedRoute] Carregando...');
    return null;
  }

  if (!isAuthenticated) {
    console.log('[AdminProtectedRoute] Não autenticado, redirecionando para login');
    return <Navigate to="/admin/login" replace />;
  }

  if (!adminProfile) {
    console.log('[AdminProtectedRoute] Sem perfil admin, redirecionando para login');
    return <Navigate to="/admin/login" replace />;
  }

  if (shouldShowWelcomeNoGroup(authz, authzStatus)) {
    // `authz` não é null aqui — `shouldShowWelcomeNoGroup` só é true com `authz` presente.
    const reason = welcomeNoGroupReason(authz!);
    console.log(`[AdminProtectedRoute] enforcement=on, WelcomeNoGroupPage (reason=${reason})`);
    return <WelcomeNoGroupPage reason={reason} />;
  }

  console.log('[AdminProtectedRoute] Autorizado, renderizando children');
  return <>{children}</>;
}
