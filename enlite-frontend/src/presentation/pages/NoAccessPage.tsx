import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Heading, Text, Button } from '@presentation/components/atoms';
import { useAuth } from '@presentation/hooks/useAuth';

interface NoAccessPageProps {
  /**
   * `none` (default) — a conta não tem vínculo nenhum. `unavailable` — tem vínculo, mas só a áreas
   * que ainda não abrem (`entryRoute = null`): dizer "sem acesso" seria enganoso.
   */
  reason?: 'none' | 'unavailable';
}

/**
 * `/no-access` (F4, T409, direção A): clone visual da `WelcomeNoGroupPage`. Texto genérico — nunca
 * nome nem e-mail da pessoa (tela de estado de erro/transição, vista por qualquer conta sem área).
 * Texto em `tertiary` (#374151, AAA) e não `secondary` (#737373, falha AAA).
 */
export function NoAccessPage({ reason = 'none' }: NoAccessPageProps): JSX.Element {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/login');
  };
  // Tentar de novo = refazer a decisão de destino do `/login` (sessão ativa), sem sair da conta.
  const handleRetry = (): void => navigate('/login');

  const prefix = reason === 'unavailable' ? 'areas.noAccess.unavailable' : 'areas.noAccess.none';

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gray-50">
      <div
        className="max-w-md w-full space-y-4 bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center"
        data-testid="no-access-page"
      >
        <Heading level={2} weight="semibold" color="primary">
          {t(`${prefix}.title`)}
        </Heading>
        <Text size="sm" color="tertiary">
          {t(`${prefix}.message`)}
        </Text>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button variant="outline" onClick={handleRetry}>
            {t('areas.noAccess.retry')}
          </Button>
          <Button variant="outline" onClick={() => void handleLogout()}>
            {t('areas.noAccess.logout')}
          </Button>
        </div>
      </div>
    </div>
  );
}
