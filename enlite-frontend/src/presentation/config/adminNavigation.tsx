import { AppSidebarNavItem } from '@presentation/components/templates/DashboardLayout';
import { useTranslation } from 'react-i18next';
import { screenVisibleFor, useCellAccess } from '@presentation/hooks/useCellAccess';
import { screenByRoute } from '@presentation/config/screenRegistry';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useFeature } from '@presentation/hooks/useFeature';
import { SCREEN_FEATURE_MAP } from './screenFeatureMap';
import { MapPin } from 'lucide-react';

export const useAdminNavItems = (): AppSidebarNavItem[] => {
  const { t } = useTranslation();
  // O item do painel de acessos deriva da célula que toda rota da família exige.
  // Sem ela, o item não existe no menu.
  const { canRead: canSeeAccess } = useCellAccess('permission_management');

  // Os itens da seção Administración NÃO têm gate próprio: passam pelo MESMO filtro dos itens
  // de topo (`comAlgumaCelulaDaTela`, abaixo — PR #313), que lê as células da tela no
  // `SCREEN_REGISTRY`. Antes de 07/09 cada um tinha um `useCellAccess(recurso)` com fallback por
  // papel (`isAdmin`) para o engine OFF; a D293 tirou o papel do front e o #313 trouxe o filtro
  // único — dois mecanismos para a mesma decisão seria a regressão (gate de 07/09, 2ª rodada).
  // Com o engine OFF o filtro devolve `true`: todo staff vê os itens e a API responde 403
  // (`untilEnforced` no back) — custo aceito de não ter duas verdades no front.
  const enforcement = useAdminAuthStore((s) => s.authz?.enforcement);
  const permissions = useAdminAuthStore((s) => s.authz?.permissions);

  // B1 (D268) — disponibilidade por país, uma verdade só: `SCREEN_FEATURE_MAP`.
  // Nº fixo de chamadas (Rules of Hooks) — as 7 chaves screen:* que hoje têm
  // item de topo (`navHref` no mapa); `screen:talentum` não tem (ver
  // screenFeatureMap.ts) e por isso não entra aqui. `screen:ana-care` ganhou
  // `navHref` na fase 1 da conferência de horas (15/09, D344).
  const valorPorChave: Record<string, boolean> = {
    'screen:management-dashboard': useFeature('screen:management-dashboard'),
    'screen:vacancies': useFeature('screen:vacancies'),
    'screen:workers': useFeature('screen:workers'),
    'screen:patients': useFeature('screen:patients'),
    'screen:funnel': useFeature('screen:funnel'),
    'screen:access-permissions': useFeature('screen:access-permissions'),
    'screen:ana-care': useFeature('screen:ana-care'),
  };
  // Deriva `href → ligada?` do mapa (via `navHref`) — sem lista à mão. Uma
  // chave sem hook chamado acima (screen:talentum) fica de fora.
  const featureByHref: Record<string, boolean> = {};
  for (const [chave, entrada] of Object.entries(SCREEN_FEATURE_MAP)) {
    if (entrada.navHref && chave in valorPorChave) featureByHref[entrada.navHref] = valorPorChave[chave];
  }
  // `/admin/recruitment/blocked-attempts` (item admin-only, ver `adminItems`
  // abaixo) não é o `navHref` de nenhuma chave — é sub-rota de `screen:funnel`
  // (ver `routes` de `screen:funnel` em screenFeatureMap.ts). Sem esta linha
  // o item ficava morto no menu quando `screen:funnel` está off: a ROTA nega
  // (App.tsx já gateia), mas o link continuava visível.
  featureByHref['/admin/recruitment/blocked-attempts'] = valorPorChave['screen:funnel'];

  const baseItems: AppSidebarNavItem[] = [
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3zM14 13a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1v-5z" />
        </svg>
      ),
      label: t('admin.nav.dashboard', 'Gestión a la Vista'),
      href: '/admin/dashboard',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ),
      label: t('admin.nav.users', 'Usuarios'),
      href: '/admin',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
        </svg>
      ),
      label: t('admin.nav.vacancies', 'Vacantes'),
      href: '/admin/vacancies',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      label: t('admin.nav.workers', 'Prestadores'),
      href: '/admin/workers',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
        </svg>
      ),
      label: t('admin.nav.patients', 'Pacientes'),
      href: '/admin/patients',
    },
    {
      icon: <MapPin className="w-6 h-6" strokeWidth={2} />,
      label: t('admin.nav.map', 'Mapa'),
      href: '/admin/mapa',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      label: t('admin.nav.anacareHours', 'Horas Ana Care'),
      href: '/admin/anacare/horas',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
      label: t('admin.nav.recruitment', 'Reclutamiento'),
      href: '/admin/recruitment',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      ),
      label: t('admin.nav.apiDocs', 'API Docs'),
      href: '/admin/api-docs',
    },
  ];

  // Admin-only items: Tags + Dedup Center + Roles de grupos + Blocked Attempts.
  // Sem gate próprio — o filtro por célula da tela é o `comAlgumaCelulaDaTela`, abaixo.
  const adminItemsDaSecao: AppSidebarNavItem[] = [
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
      ),
      label: t('admin.nav.tags', 'Etiquetas'),
      href: '/admin/tags',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      ),
      label: t('admin.nav.dedup', 'Duplicados'),
      href: '/admin/dedup',
    },
    {
      icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h8m-8 4h5m-9 6l3-3h9a2 2 0 002-2V7a2 2 0 00-2-2H6a2 2 0 00-2 2v13z" />
            </svg>
          ),
      label: t('admin.nav.funnelStageMessages', 'Mensajes por etapa'),
      href: '/admin/mensajes-por-etapa',
    },
    {
      icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          ),
      label: t('admin.nav.templateCatalog', 'Plantillas'),
      href: '/admin/plantillas',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.2-3.6A7.9 7.9 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      ),
      label: t('admin.nav.patientChatRoles', 'Roles de grupos'),
      href: '/admin/patient-chat-roles',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      ),
      label: t('admin.nav.catalogObjectives', 'Objetivos específicos'),
      href: '/admin/catalogos/objetivos-especificos',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
        </svg>
      ),
      label: t('admin.nav.catalogActivities', 'Rutina y actividades'),
      href: '/admin/catalogos/actividades',
    },
    {
      icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3M5 11h14M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zm7 9v-4m-2 2h4" />
            </svg>
          ),
      label: t('admin.nav.presentationInvite', 'Invitación a presentación'),
      href: '/admin/invitacion-presentacion',
    },
    {
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
      ),
      label: t('admin.nav.blockedAttempts', 'Postulaciones bloqueadas'),
      href: '/admin/recruitment/blocked-attempts',
    },
  ];
  // D286 (bug visto na stage em 07/09): os itens de topo (Pacientes, Prestadores, Vacantes, Mapa…)
  // só passavam pelo filtro de PAÍS (`semFeatureDesligada`, abaixo) — nunca por célula — e
  // apareciam para quem não tinha nenhuma. Regra: o item existe para quem tem QUALQUER célula da
  // tela que ele abre (própria ou de container), a mesma régua das abas (`tabsVisibleFor`); a tela
  // vem do registro pela rota, sem lista à mão. Href sem tela no registro (API Docs) fica: a rota
  // do back exige só staff, e o menu não inventa célula que a rota não cobra. Engine OFF → `true`.
  const comAlgumaCelulaDaTela = (item: AppSidebarNavItem): boolean => {
    const screen = screenByRoute(item.href);
    return screen === undefined || screenVisibleFor(screen, permissions, enforcement);
  };

  const itensDeTopo = baseItems.filter(comAlgumaCelulaDaTela);
  // Antes do `sectionStart`: o título da seção tem de cair num item que sobrevive.
  const adminItems: AppSidebarNavItem[] = adminItemsDaSecao.filter(comAlgumaCelulaDaTela);
  // `sectionStart` marca o início visual da seção "Administración" — precisa
  // estar no primeiro item que sobreviveu ao filtro, não fixo no de Tags
  // (que agora pode estar ausente sem os outros 3 sumirem junto).
  if (adminItems.length > 0) {
    adminItems[0] = { ...adminItems[0], sectionStart: t('admin.nav.adminSection', 'Administración') };
  }

  const accessItems: AppSidebarNavItem[] = canSeeAccess
    ? [
        {
          icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ),
          label: t('admin.nav.access', 'Accesos y permisos'),
          href: '/admin/access',
          ...(adminItems.length === 0 ? { sectionStart: t('admin.nav.adminSection', 'Administración') } : {}),
        },
      ]
    : [];

  // `featureByHref[href] === false` remove o item; hrefs fora do mapa (ex.
  // `/admin`, `/admin/tags`) não são chaves `screen:*` — ficam de fora.
  const semFeatureDesligada = (item: AppSidebarNavItem): boolean =>
    item.href === undefined || featureByHref[item.href] !== false;

  // `accessItems` já nasce pela célula (`canSeeAccess`) — a mesma que o registro lista para `/admin/access`.
  return [...itensDeTopo, ...adminItems, ...accessItems].filter(semFeatureDesligada);
};
