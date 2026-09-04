import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Heading, Text, Button } from '@presentation/components/atoms';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';

/**
 * A1 (D268) — o shell admin inteiro quando `shouldShowWelcomeNoGroup` é true
 * (`AdminProtectedRoute`, ponto único que cobre TODA rota `/admin/*`).
 *
 * Sem menu operacional de propósito: quem cai aqui não tem célula nenhuma
 * ainda, e um item de menu que redireciona pra "hidden" em toda página é
 * pior UX que não ter menu. Texto genérico — nunca nome nem e-mail do ator
 * (a tela é vista por qualquer staff sem grupo, e não é lugar de expor PII
 * do próprio ator num estado de erro/transição).
 */
export function WelcomeNoGroupPage(): JSX.Element {
  const { t } = useTranslation();
  const { logout } = useAdminAuth();
  const navigate = useNavigate();

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/admin/login');
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-4 bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
        <Heading level={2} weight="semibold" color="primary">
          {t('admin.welcomeNoGroup.title')}
        </Heading>
        <Text size="sm" color="secondary">
          {t('admin.welcomeNoGroup.message')}
        </Text>
        <Button variant="outline" onClick={() => void handleLogout()}>
          {t('admin.welcomeNoGroup.logout')}
        </Button>
      </div>
    </div>
  );
}
