import type { ReactNode } from 'react';
import { Navigate, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Heading, Text } from '@presentation/components/atoms';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import { PanelErrorAlert } from '@presentation/components/features/access';

/** O recurso que governa o painel inteiro — a mesma célula que TODA rota da família exige. */
export const PANEL_RESOURCE = 'permission_management';

/**
 * A moldura do painel: só existe para quem tem `permission_management:read`.
 *  - contrato carregando → diz que está carregando (não renderiza o painel);
 *  - contrato em erro → diz que falhou (fail-closed: nada do painel aparece);
 *  - `hidden` → redireciona para a home admin — a URL não é porta;
 *  - `read`/`write` → abas + conteúdo, e um aviso quando é só leitura.
 */
export function AccessGate({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation();
  const access = useCellAccess(PANEL_RESOURCE);

  if (access.status === 'idle' || access.status === 'loading') {
    return <Text size="sm" color="secondary">{t('admin.access.loading')}</Text>;
  }
  if (access.status === 'error') return <PanelErrorAlert keyName="admin.access.authzError" />;
  if (access.level === 'hidden') return <Navigate to="/admin" replace />;

  const tab = 'px-3 py-2 rounded-lg text-sm';
  return (
    <div className="space-y-6">
      <div>
        <Heading level={1} weight="semibold" color="primary">{t('admin.access.title')}</Heading>
        <Text size="sm" color="secondary">{t('admin.access.subtitle')}</Text>
      </div>
      <nav className="flex gap-2 border-b border-gray-200 pb-2" aria-label={t('admin.access.title')}>
        <NavLink end to="/admin/access" className={({ isActive }) => `${tab} ${isActive ? 'bg-gray-100 font-semibold' : ''}`}>
          {t('admin.access.tabs.groups')}
        </NavLink>
        <NavLink to="/admin/access/features" className={({ isActive }) => `${tab} ${isActive ? 'bg-gray-100 font-semibold' : ''}`}>
          {t('admin.access.tabs.features')}
        </NavLink>
        <NavLink to="/admin/access/audit" className={({ isActive }) => `${tab} ${isActive ? 'bg-gray-100 font-semibold' : ''}`}>
          {t('admin.access.tabs.history')}
        </NavLink>
      </nav>
      {access.level === 'read' && (
        <div className="bg-amber-50 border border-amber-200 px-4 py-2 rounded-lg" data-testid="read-only-notice">
          <Text size="xs" color="primary">{t('admin.access.readOnlyNotice')}</Text>
        </div>
      )}
      {children}
    </div>
  );
}
