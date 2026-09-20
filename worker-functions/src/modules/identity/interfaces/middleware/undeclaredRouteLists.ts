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
  // `GET /v1/me/authz` não está mais aqui (28/08/2026): a isenção dela é
  // declarada NA MONTAGEM (`exemptHandler('self…')` em `meAuthzRoute.ts`), e a
  // marca é o que a põe no perímetro como `exempt`. As três acima moram sob o
  // prefixo e seguem isentas por esta lista — migrá-las para a marca é decisão
  // dos donos de cada router.
  //
  // `PATCH /api/admin/patients/:id/support-network` (spec 018, PR-1, ADR-1,
  // SUP-37): a rota da lista INTEIRA foi decomissionada — responde 410 sempre,
  // sem tocar em nenhum dado de paciente. Não há célula que faça sentido pedir
  // para uma rota que só recusa; a escrita de verdade migrou para as rotas por
  // linha (`patient_family:write`), que declaram normalmente.
  'PATCH /api/admin/patients/:id/support-network',
  // `POST /api/admin/patients/:id/activate` (spec 018, PR-6, ADR-5,
  // contracts/activation.md): mesma decisão — a rota responde 410 sempre (`ACTIVATION_SPLIT`),
  // sem tocar em nenhum dado de paciente. Ativar recrutamento migrou para
  // `POST /:id/contracted-services/:sid/activate-recruitment` (`patient_services:write` +
  // `vacancy:write`), que declara célula normalmente.
  'POST /api/admin/patients/:id/activate',
]);

/**
 * Gerado da varredura real do router (não escrito à mão) e conferido a cada
 * boot. Ordem: método + caminho, como o app registrou.
 */
export const PENDING_DECLARATIONS: ReadonlySet<string> = new Set([
]);
