/**
 * src/modules/identity/interfaces/routes/permissionRoutesInventoryRoute.ts
 *
 * `GET /.well-known/permissions/routes` — o inventário VIVO das rotas
 * governadas e do que cada uma declara.
 *
 * Existe por uma limitação concreta: `src/index.ts` monta a app com efeito
 * colateral (abre pools, sobe o servidor), então nenhum teste unitário
 * consegue importá-lo para varrer o router de verdade. O oráculo completo de
 * "toda rota administrativa declara célula" só existe com o app DE PÉ — e é
 * daqui que o e2e o lê, contra o app real, com banco real.
 *
 * (lex C14) Mesmo guard do `/.well-known/permissions`: a lista conta topologia
 * (onde ficam as ações destrutivas) e por isso não é pública.
 *
 * Não expõe nada além de método, caminho registrado e célula declarada —
 * nenhum dado de pessoa passa por aqui.
 */

import { Router, type RequestHandler } from 'express';
import { cellKey } from '@modules/identity/permissions';
import type { UndeclaredRouteRegistry } from '../middleware/denyUndeclaredRoutes';
import { isGovernedRoute } from '../middleware/denyUndeclaredRoutes';

export function createPermissionRoutesInventoryRouter(
  registry: UndeclaredRouteRegistry,
  guard: RequestHandler,
): Router {
  const router = Router();

  router.get('/permissions/routes', guard, (_req, res) => {
    const routes = registry.all();
    const governed = routes.filter(isGovernedRoute).map((route) => ({
      method: route.method,
      path: route.path,
      cell: route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      status: registry.statusOfRoute(route),
    }));

    res.json({
      totalRoutes: routes.length,
      governedRoutes: governed,
      undeclared: registry.unexpectedlyUndeclared().map((route) => `${route.method} ${route.path}`),
    });
  });

  return router;
}
