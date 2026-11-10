import type { ReactNode } from 'react';
import { Navigate, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Heading, Text } from '@presentation/components/atoms';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import { PanelErrorAlert } from '@presentation/components/features/access';

/** O recurso que governa o painel inteiro — a mesma célula que TODA rota da família exige. */
export const PANEL_RESOURCE = 'permission_management';

/** O recurso das células `area_membership:read|write` (catálogo do back, T111) — a aba "Vínculos de área". */
export const AREA_MEMBERSHIP_RESOURCE = 'area_membership';

/** Qual aba a página montada é — decide a que célula o aviso de "só leitura" e a guarda respondem. */
export type AccessTab = 'groups' | 'areaMemberships';

const AREA_MEMBERSHIPS_PATH = '/admin/access/area-memberships';

/**
 * A moldura do painel. A página abre para quem tem `permission_management:read` OU `area_membership:read`;
 * cada aba existe só para quem tem a célula dela (quem só tem `area_membership:read` vê só "Vínculos de área"):
 *  - contrato carregando → diz que está carregando (não renderiza o painel);
 *  - contrato em erro → diz que falhou (fail-closed: nada do painel aparece);
 *  - nenhuma das duas células → redireciona para a home admin — a URL não é porta;
 *  - aba sem a célula → redireciona para a aba que o ator pode ver;
 *  - `read`/`write` → abas + conteúdo, e um aviso quando a célula DA ABA ATUAL é só leitura.
 */
export function AccessGate({ children, tab = 'groups' }: { children: ReactNode; tab?: AccessTab }): JSX.Element {
  const { t } = useTranslation();
  const groups = useCellAccess(PANEL_RESOURCE);
  const links = useCellAccess(AREA_MEMBERSHIP_RESOURCE);

  if (groups.status === 'idle' || groups.status === 'loading') {
    return <Text size="sm" color="secondary">{t('admin.access.loading')}</Text>;
  }
  if (groups.status === 'error') return <PanelErrorAlert keyName="admin.access.authzError" />;
  const canGroups = groups.level !== 'hidden';
  const canLinks = links.level !== 'hidden';
  if (!canGroups && !canLinks) return <Navigate to="/admin" replace />;
  if (tab === 'groups' && !canGroups) return <Navigate to={AREA_MEMBERSHIPS_PATH} replace />;
  if (tab === 'areaMemberships' && !canLinks) return <Navigate to="/admin/access" replace />;

  const current = tab === 'groups' ? groups : links;
  const link = 'px-3 py-2 rounded-lg text-sm text-primary';
  const cls = ({ isActive }: { isActive: boolean }): string => `${link} ${isActive ? 'bg-gray-100 font-semibold' : ''}`;
  return (
    <div className="space-y-6">
      <div>
        <Heading level={1} weight="semibold" color="primary">{t('admin.access.title')}</Heading>
        <Text size="sm" color="tertiary">{t('admin.access.subtitle')}</Text>
      </div>
      <nav className="flex gap-2 border-b border-gray-200 pb-2" aria-label={t('admin.access.title')}>
        {canGroups && <NavLink end to="/admin/access" className={cls}>{t('admin.access.tabs.groups')}</NavLink>}
        {canLinks && (
          <NavLink to={AREA_MEMBERSHIPS_PATH} className={cls} data-testid="access-tab-area-memberships">
            {t('admin.access.tabs.areaMemberships')}
          </NavLink>
        )}
        {canGroups && <NavLink to="/admin/access/features" className={cls}>{t('admin.access.tabs.features')}</NavLink>}
        {canGroups && <NavLink to="/admin/access/audit" className={cls}>{t('admin.access.tabs.history')}</NavLink>}
      </nav>
      {current.level === 'read' && (
        <div className="bg-amber-50 border border-amber-200 px-4 py-2 rounded-lg" data-testid="read-only-notice">
          <Text size="xs" color="primary">{t('admin.access.readOnlyNotice')}</Text>
        </div>
      )}
      {children}
    </div>
  );
}
