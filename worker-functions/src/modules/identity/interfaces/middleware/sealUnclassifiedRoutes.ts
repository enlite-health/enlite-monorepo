/**
 * src/modules/identity/interfaces/middleware/sealUnclassifiedRoutes.ts
 *
 * Selo de bloqueio por padrão (acesso-do-cliente F3, DF-14): TODA rota precisa
 * declarar uma classe (`staff` via `requireStaff`, ou `public|service|client-policy`
 * via `routeClass(...)`), uma célula (`perm.require`) ou uma isenção
 * (`exemptHandler`). Rota sem nenhuma das três responde 403 — rota nova esquecida
 * deixa de nascer aberta.
 *
 * Estende o `denyUndeclaredRoutes`, que só governa `/api/admin`, `/analytics` e
 * `GOVERNED_ROUTES`. NÃO duplica a varredura: lê o MESMO índice que o boot
 * publica no `UndeclaredRouteRegistry` (`scanExpressRouter` + `buildRouteIndex`).
 *
 * Dois momentos (mesmo desenho do guard irmão):
 *   · BOOT — `unclassifiedRoutes(routes)` mede a dívida e o boot a loga;
 *   · RUNTIME — este middleware nega a request cuja rota casa com uma não classificada.
 * Antes do boot publicar o índice a resposta é "passa" (corrida de inicialização
 * não pode derrubar o app); caminho que não casa com rota nenhuma vira 404 do Express.
 *
 * Independe de `PERMISSION_ENGINE_ENABLED` (classe é contrato de rota, não do
 * motor); `PERMISSION_REPORT_ONLY` mantém a válvula de "só logar".
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '@shared/logging';
import { isEnvFlagOn } from '@shared/utils/envFlag';
import type { ScannedRoute } from '@modules/identity/permissions';
import type { UndeclaredRouteRegistry } from './denyUndeclaredRoutes';
import { pathOf } from './PermissionMiddleware';

/** Rota de verdade (não `USE` de middleware) sem classe, sem célula e sem isenção. */
export function isUnclassified(route: ScannedRoute): boolean {
  return route.method !== 'USE' && route.class == null && !route.cell && !route.exempt;
}

export function unclassifiedRoutes(routes: ScannedRoute[]): ScannedRoute[] {
  return routes.filter(isUnclassified);
}

export function sealUnclassifiedRoutes(
  registry: UndeclaredRouteRegistry,
  options: { env?: NodeJS.ProcessEnv } = {},
): RequestHandler {
  const env = options.env ?? process.env;

  return (req: Request, res: Response, next: NextFunction): void => {
    // O Express atende HEAD pela rota GET.
    const method = req.method.toUpperCase() === 'HEAD' ? 'GET' : req.method;
    const route = registry.find(method, req.path);
    if (!route || !isUnclassified(route)) return next();

    logger.error(
      { method: req.method, path: pathOf(req) },
      '[perm] rota sem classe declarada — negada (selo F3)',
    );
    if (isEnvFlagOn('PERMISSION_REPORT_ONLY', env)) return next();
    res.status(403).json({
      success: false,
      error: 'Access denied',
      code: 'unclassified_route',
      reason: 'Esta rota não declara classe de acesso. Fale com o time de engenharia.',
    });
  };
}
