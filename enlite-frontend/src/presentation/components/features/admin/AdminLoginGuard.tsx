import { ReactNode, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { ADMIN_HOME_PATH } from '@presentation/config/adminHome';

interface AdminLoginGuardProps {
  children: ReactNode;
}

/**
 * Guard para a página de login admin
 *
 * Proteções:
 * 1. Se admin já está autenticado, redireciona para /admin/dashboard
 * 2. Caso contrário, permite acesso à página de login
 *
 * Nota: a verificação de "worker autenticado" foi removida porque usa a mesma
 * instância Firebase do admin. Durante o login do admin, o worker auth detecta
 * o usuário antes do perfil admin ser carregado, causando um redirect prematuro
 * para `/`. A proteção real fica em AdminProtectedRoute em todas as rotas /admin/*.
 */
export function AdminLoginGuard({ children }: AdminLoginGuardProps): JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated: isAdminAuth, isLoading: isAdminLoading, adminProfile } = useAdminAuth();

  useEffect(() => {
    if (isAdminLoading) return;

    if (isAdminAuth && adminProfile) {
      console.log('[AdminLoginGuard] Admin já autenticado, redirecionando para', ADMIN_HOME_PATH);
      navigate(ADMIN_HOME_PATH, { replace: true });
    }
  }, [isAdminAuth, isAdminLoading, adminProfile, navigate]);

  if (isAdminLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (isAdminAuth && adminProfile) {
    return <Navigate to={ADMIN_HOME_PATH} replace />;
  }

  return <>{children}</>;
}
