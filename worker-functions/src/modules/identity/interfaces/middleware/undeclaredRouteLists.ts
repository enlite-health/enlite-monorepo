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
