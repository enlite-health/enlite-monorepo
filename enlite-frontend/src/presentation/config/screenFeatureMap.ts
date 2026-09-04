/**
 * B2 (D268) — as 8 chaves `screen:*` de `country-features.manifest.ts`
 * (worker-functions, NÃO editado aqui — lido, não importado: os dois pacotes
 * não compartilham resolução de módulo, e o teste de paridade (B3) confere
 * que este mapa continua ⊇ o manifest via a MESMA fixture gerada por
 * `scripts/sync-permission-catalog.mjs`).
 *
 * Usado em DOIS pontos só, de propósito (nada mais lê isto):
 *  - `adminNavigation.tsx` — filtra o item de menu pelo `navHref`;
 *  - `App.tsx` — envolve a(s) `<Route>` da tela com `FeatureRouteGate`.
 *
 * `screen:ana-care` não tem tela nem rota hoje (medido: grep em src/presentation
 * não acha nada) — entra com `semConsumidorHoje` explícito, nunca ausente do
 * mapa (ausente pareceria "esquecido"; isto documenta "decidido, sem tela ainda").
 */
export interface ScreenFeatureEntry {
  /** `href` do item em `useAdminNavItems` que este `screen:*` controla — `undefined` = a tela não tem item de topo (aninhada). */
  navHref?: string;
  /** Paths de rota (App.tsx) gateados por esta chave — vazio quando a tela ainda não existe no painel. */
  routes: string[];
  /** Só para chaves sem consumidor hoje — o motivo fica aqui, nunca a chave ausente do mapa. */
  semConsumidorHoje?: string;
}

export const SCREEN_FEATURE_MAP: Readonly<Record<string, ScreenFeatureEntry>> = {
  'screen:workers': { navHref: '/admin/workers', routes: ['/admin/workers', '/admin/workers/:id'] },
  'screen:vacancies': {
    navHref: '/admin/vacancies',
    routes: [
      '/admin/vacancies',
      '/admin/vacancies/new',
      '/admin/vacancies/pending-address-review',
      '/admin/vacancies/:id/edit',
      '/admin/vacancies/:id',
    ],
  },
  'screen:funnel': {
    navHref: '/admin/recruitment',
    routes: ['/admin/recruitment', '/admin/recruitment/health', '/admin/recruitment/blocked-attempts'],
  },
  'screen:patients': {
    navHref: '/admin/patients',
    routes: ['/admin/patients', '/admin/patients/kanban', '/admin/patients/:id'],
  },
  'screen:management-dashboard': { navHref: '/admin/dashboard', routes: ['/admin/dashboard'] },
  'screen:access-permissions': {
    navHref: '/admin/access',
    routes: ['/admin/access', '/admin/access/groups/:id', '/admin/access/features', '/admin/access/audit'],
  },
  /** Sem item de topo — chega-se via link dentro do detalhe de vaga (`vacancies/:id/talentum`). */
  'screen:talentum': { routes: ['/admin/vacancies/:id/talentum'] },
  'screen:ana-care': {
    routes: [],
    semConsumidorHoje: 'Ana Care não tem tela nem rota no painel hoje (grep em src/presentation não acha nada) — a chave existe no manifest, o consumidor ainda não foi construído.',
  },
};
