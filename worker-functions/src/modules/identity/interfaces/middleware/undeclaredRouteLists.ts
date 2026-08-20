/**
 * src/modules/identity/interfaces/middleware/undeclaredRouteLists.ts
 *
 * As duas listas do deny-when-undeclared (task 3.4). Ficam num arquivo só, sem
 * lógica, porque são DADO revisável: quem lê o PR precisa ver a lista inteira
 * mudar de tamanho, não caçá-la dentro de um middleware.
 *
 * ISENTAS — decisão de produto, permanente (D116): estas rotas não são decisão
 * de staff, então não existe célula que faça sentido pedir.
 *
 * PENDENTES — dívida do rollout, temporária: a família ainda não passou pela
 * task 3.5. **Esta lista só encolhe.** O teste `declaredRoutes.test.ts` (e o
 * e2e contra o app real) falha se aparecer rota governada fora das duas
 * listas — que é como uma rota nova sem declaração vira build vermelho, e não
 * um 403 descoberto em produção. Quando ela zerar, a task 3.5 está completa e
 * `PERMISSION_CATALOG_SYNC_ENABLED` pode ser ligada (antes disso o sync
 * marcaria como descontinuadas as células cujas rotas ainda não declararam).
 */

/** Chave estável de uma rota: `MÉTODO caminho-registrado`. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export const EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  // Bootstrap do 1º admin: roda sem autenticação por definição (guard próprio:
  // countAdmins() > 0 → 403, mais o gate ADMIN_SETUP_ENABLED).
  'POST /api/admin/setup',
  // Perfil próprio — auto-provisionamento no 1º login do Google. Exigir célula
  // aqui trancaria fora justamente quem ainda não tem grupo (é o caminho da
  // tela de boas-vindas).
  'GET /api/admin/auth/profile',
  // Telemetria do login (o front reporta falha de autenticação). É `self`, não
  // decisão de staff, e roda com optionalAuth.
  'POST /api/admin/auth/telemetry',
]);

/**
 * Gerado da varredura real do router (não escrito à mão) e conferido a cada
 * boot. Ordem: método + caminho, como o app registrou.
 */
export const PENDING_DECLARATIONS: ReadonlySet<string> = new Set([
  // ── admin.vacancies (45) ───────────────────────────────────
  'GET /api/admin/vacancies',
  'GET /api/admin/vacancies/stats',
  'GET /api/admin/vacancies/next-vacancy-number',
  'GET /api/admin/vacancies/cases-for-select',
  'GET /api/admin/vacancies/filter-options',
  'GET /api/admin/vacancies/pending-address-review',
  'GET /api/admin/vacancies/in-progress',
  'GET /api/admin/vacancies/by-address',
  'GET /api/admin/vacancies/:id',
  'POST /api/admin/vacancies',
  'PUT /api/admin/vacancies/:id',
  'DELETE /api/admin/vacancies/:id',
  'POST /api/admin/vacancies/:id/resolve-address-review',
  'GET /api/admin/vacancies/:id/match-results',
  'POST /api/admin/vacancies/:id/match',
  'PUT /api/admin/encuadres/:id/result',
  'POST /api/admin/vacancies/:id/publish-talentum',
  'DELETE /api/admin/vacancies/:id/publish-talentum',
  'POST /api/admin/vacancies/:id/generate-talentum-description',
  'PUT /api/admin/vacancies/:id/talentum-description',
  'POST /api/admin/vacancies/:id/generate-ai-content',
  'POST /api/admin/vacancies/sync-talentum',
  'GET /api/admin/vacancies/:id/prescreening-config',
  'GET /api/admin/vacancies/:id/talentum-status',
  'POST /api/admin/vacancies/:id/prescreening-config',
  'POST /api/admin/vacancies/meet-links/lookup',
  'PUT /api/admin/vacancies/:id/meet-links',
  'POST /api/admin/vacancies/:id/social-links',
  'GET /api/admin/vacancies/:id/social-links-stats',
  'GET /api/admin/vacancies/:id/funnel',
  'PUT /api/admin/encuadres/:id/move',
  'POST /api/admin/vacancies/blocked-applications/:blockedId/reject',
  'POST /api/admin/vacancies/blocked-applications/:blockedId/restore',
  'GET /api/admin/vacancies/:id/funnel-table',
  'GET /api/admin/dashboard/coordinator-capacity',
  'GET /api/admin/dashboard/alerts',
  'GET /api/admin/dashboard/conversion-by-channel',
  'POST /api/admin/vacancies/:id/interview-slots',
  'GET /api/admin/vacancies/:id/interview-slots',
  'POST /api/admin/interview-slots/:slotId/book',
  'DELETE /api/admin/interview-slots/:slotId',
  'GET /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes',
  'POST /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes',
  'DELETE /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes/:noteId',
  'GET /api/admin/vacancies/:vacancyId/workers/:workerId/delivery-status',
  // ── admin.analytics (15) ───────────────────────────────────
  'GET /analytics/workers',
  'GET /analytics/workers/missing-documents',
  'GET /analytics/workers/:workerId/vacancies',
  'GET /analytics/vacancies',
  'GET /analytics/vacancies/case/:caseNumber',
  'GET /analytics/vacancies/:id/incomplete-registrations',
  'GET /analytics/vacancies/:id',
  'GET /analytics/dedup/candidates',
  'POST /analytics/dedup/run',
  'GET /analytics/dashboard/global',
  'GET /analytics/dashboard/zones',
  'GET /analytics/dashboard/reemplazos',
  'GET /analytics/dashboard/management',
  'GET /analytics/dashboard/zone-analytics',
  'GET /analytics/dashboard/cases/:caseNumber',
  // ── admin.recruitment (11) ─────────────────────────────────
  'GET /api/admin/recruitment/clickup-cases',
  'GET /api/admin/recruitment/talentum-workers',
  'GET /api/admin/recruitment/progreso',
  'GET /api/admin/recruitment/publications',
  'GET /api/admin/recruitment/encuadres',
  'GET /api/admin/recruitment/global-metrics',
  'GET /api/admin/recruitment/case/:caseNumber',
  'GET /api/admin/recruitment/zones',
  'POST /api/admin/recruitment/calculate-reemplazos',
  'GET /api/admin/recruitment/blocked-attempts',
  'GET /api/admin/recruitment/health',
  // ── admin.dedup (9) ────────────────────────────────────────
  'GET /api/admin/dedup/groups',
  'GET /api/admin/dedup/groups/:phoneNormalized',
  'POST /api/admin/dedup/merge',
  'POST /api/admin/dedup/dismiss',
  'POST /api/admin/dedup/merges/:auditId/undo',
  'GET /api/admin/dedup/history',
  'GET /api/admin/dedup/imported-groups',
  'GET /api/admin/dedup/candidates',
  'POST /api/admin/dedup/manual-group',
  // ── admin.messaging (7) ────────────────────────────────────
  'POST /api/admin/messaging/whatsapp/vacancy-match',
  'POST /api/admin/messaging/whatsapp/direct',
  'GET /api/admin/messaging/templates',
  'POST /api/admin/messaging/templates',
  'PUT /api/admin/messaging/templates/:slug',
  'DELETE /api/admin/messaging/templates/:slug',
  'POST /api/admin/messaging/bulk-dispatch-incomplete',
  // ── admin.integrations (1) ─────────────────────────────────
  'POST /api/admin/integrations/anacare/backfill',
  // ── admin.outras (1) ───────────────────────────────────────
  'POST /api/admin/test-fixtures/cleanup',
  // ── encuadre/funil fora do prefixo (10) ─────────────────────────
  // Entraram no perímetro por NOME em 19/08 (`GOVERNED_ROUTES`): são
  // `requireStaff` mas vivem sob `/api/workers/` e `/api/cases/`, então estavam
  // `not_governed` — fora do deny-by-default e fora desta lista. A dívida não
  // cresceu: ela ficou VISÍVEL. Declarar é família própria, PR seguinte.
  'GET /api/workers/status-dashboard',
  'GET /api/workers/by-status/:status',
  'PUT /api/workers/:id/status',
  'PUT /api/workers/:id/occupation',
  'GET /api/workers/docs-expiring',
  'PUT /api/workers/:id/doc-expiry',
  'GET /api/workers/:id/encuadres',
  'GET /api/workers/:id/cases',
  'GET /api/cases/:caseNumber/encuadres',
  'GET /api/cases/:caseNumber/workers',
]);
