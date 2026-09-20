/**
 * cellHelpImages — que recursos têm uma CAPTURA do componente a que a célula se refere, mostrada no
 * painel de ajuda do "?" (pedido do Gabriel, 06/09: "colocar um print do componente que aquela
 * permissão se refere, para o operador não ter dúvidas do que é").
 *
 * As imagens vivem em `public/ayuda-celulas/<recurso>.png` (servidas como estão, fora do bundle) e
 * são geradas por `scripts/capturar-ajuda-celulas.mjs` contra o stack local com dado SINTÉTICO —
 * nunca de produção nem da stage. Recurso fora desta lista não tem imagem, e o drawer não tenta
 * carregar nada (nada de 404 no console). Quando a tela mudar, regravar.
 */
export const CELL_HELP_IMAGES: ReadonlySet<string> = new Set([
  'patient', 'patient_identity', 'patient_clinical', 'patient_care_team', 'patient_family', 'patient_chat',
  'patient_coverage', 'patient_address', 'patient_services',
  'worker', 'worker_contact', 'worker_pii', 'worker_address', 'worker_document',
  'vacancy', 'funnel', 'match', 'messaging', 'prescreening', 'talentum',
  'dashboard', 'dashboard_numbers', 'dashboard_team', 'dashboard_priorities', 'dashboard_registrations', 'dashboard_funnel', 'dashboard_zones',
  'user_management', 'permission_management', 'dedup', 'recruitment',
]);

export const cellHelpImageUrl = (resource: string): string | null =>
  CELL_HELP_IMAGES.has(resource) ? `/ayuda-celulas/${resource}.png` : null;
