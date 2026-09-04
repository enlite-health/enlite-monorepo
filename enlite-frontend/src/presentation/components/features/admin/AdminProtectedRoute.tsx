import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { shouldShowWelcomeNoGroup, welcomeNoGroupReason } from '@domain/entities/Authz';
import { WelcomeNoGroupPage } from '@presentation/pages/admin/WelcomeNoGroupPage';

interface AdminProtectedRouteProps {
  children: ReactNode;
}

/** O mesmo spinner de tela cheia do `AdminFallback` (App.tsx) — o `loading` SEM contrato prévio usa este, não o layout com `Outlet` vazio. */
function AuthzLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background" data-testid="admin-authz-loading">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );
}

/**
 * Ponto ÚNICO de condicionamento da A1 (D268): esta rota envolve `<AdminLayout>`
 * na raiz de `/admin` (App.tsx), e TODA rota `/admin/*` é filha dele via
 * `Outlet` — então checar aqui, uma vez, cobre a família inteira sem duplicar
 * o gate em cada página.
 *
 * `loading` COM contrato antigo (stale-while-revalidate — `fetchAuthz`
 * preserva o `authz` anterior nesse caso) cai no fallthrough normal: os
 * children continuam na tela com o contrato velho até o novo chegar. Só
 * `loading` SEM nenhum contrato prévio mostra o spinner — sem isso o
 * `AdminLayout` renderizava com `Outlet` vazio a cada troca de área (achado
 * real, D269 Parte 2): a tela de boas-vindas sumia e voltava, e o menu
 * aparecia com conteúdo em branco. `error` continua caindo no fallthrough —
 * a postura de erro é de cada página (ex. `AccessGate`).
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

  if (authzStatus === 'loading' && !authz) {
    console.log('[AdminProtectedRoute] authz loading sem contrato prévio — spinner, não Outlet vazio');
    return <AuthzLoading />;
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
