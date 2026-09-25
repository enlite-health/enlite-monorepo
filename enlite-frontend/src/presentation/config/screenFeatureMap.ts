/**
 * B2 (D268) — as 8 chaves `screen:*` de `country-features.manifest.ts`
 * (worker-functions, NÃO editado aqui — lido, não importado: os dois pacotes
 * não compartilham resolução de módulo, e o teste de paridade (B3) confere
 * que este mapa continua ⊇ o manifest via a MESMA fixture gerada por
 * `scripts/sync-permission-catalog.mjs`).
 *
 * Usado em TRÊS pontos (B1/D268):
 *  - `adminNavigation.tsx` — DERIVA `featureByHref` deste mapa (via `navHref`)
 *    pra filtrar o item de menu; NÃO reescreve a lista à mão;
 *  - `App.tsx` — envolve cada `<Route>` da tela com `FeatureRouteGate`,
 *    passando a chave `screen:*` correspondente como literal (por
 *    legibilidade — a paridade com `routes[]` abaixo é travada por
 *    `screenFeatureMap.test.ts`, que lê `App.tsx` como texto, não por import);
 *  - `screenFeatureMap.test.ts` — confere as DUAS pontas acima: toda rota
 *    `/admin/*` gateada em App.tsx bate com `routes[]` aqui (nos dois
 *    sentidos), e todo `navHref` existe de fato em `adminNavigation.tsx`.
 *
 * `screen:ana-care` ganhou tela na fase 1 da conferência de horas (15/09, D344) — as duas rotas
 * abaixo (`/admin/anacare/horas`, `/admin/anacare/horas/:patientId`) e item de menu próprio
 * (`navHref: '/admin/anacare/horas'`, ver `adminNavigation.tsx`).
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
      '/admin/vacancies/:id/borrador',
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
    navHref: '/admin/anacare/horas',
    routes: ['/admin/anacare/horas', '/admin/anacare/horas/:patientId'],
  },
};
