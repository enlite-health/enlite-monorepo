import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Heading, Text, Button } from '@presentation/components/atoms';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import type { WelcomeNoGroupReason } from '@domain/entities/Authz';

interface WelcomeNoGroupPageProps {
  /** `sem-grupo` (default) ou `inativo` — `welcomeNoGroupReason(authz)` decide qual. */
  reason?: WelcomeNoGroupReason;
}

/**
 * A1 (D268) — o shell admin inteiro quando `shouldShowWelcomeNoGroup` é true
 * (`AdminProtectedRoute`, ponto único que cobre TODA rota `/admin/*`).
 *
 * Sem menu operacional de propósito: quem cai aqui não tem célula nenhuma
 * ainda, e um item de menu que redireciona pra "hidden" em toda página é
 * pior UX que não ter menu. Texto genérico — nunca nome nem e-mail do ator
 * (a tela é vista por qualquer staff sem grupo/inativo, e não é lugar de
 * expor PII do próprio ator num estado de erro/transição).
 *
 * Duas mensagens (Welcome/D268): `sem-grupo` — a conta existe, só falta
 * grupo. `inativo` — a conta SAIU de `ACTIVE` (suspensa/desativada) e AINDA
 * pode ter grupo; dizer "sem grupo" pra essa conta seria enganoso (o
 * problema não é grupo, é a própria conta).
 */
export function WelcomeNoGroupPage({ reason = 'sem-grupo' }: WelcomeNoGroupPageProps): JSX.Element {
  const { t } = useTranslation();
  const { logout } = useAdminAuth();
  const navigate = useNavigate();

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/admin/login');
  };

  const tituloKey = reason === 'inativo' ? 'admin.welcomeNoGroup.inactiveTitle' : 'admin.welcomeNoGroup.title';
  const mensagemKey = reason === 'inativo' ? 'admin.welcomeNoGroup.inactiveMessage' : 'admin.welcomeNoGroup.message';

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-4 bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
        <Heading level={2} weight="semibold" color="primary">
          {t(tituloKey)}
        </Heading>
        <Text size="sm" color="secondary">
          {t(mensagemKey)}
        </Text>
        <Button variant="outline" onClick={() => void handleLogout()}>
          {t('admin.welcomeNoGroup.logout')}
        </Button>
      </div>
    </div>
  );
}
