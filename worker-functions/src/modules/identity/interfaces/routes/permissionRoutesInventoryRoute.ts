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
      // TODAS as células da rota, não só a 1ª (achado pós-#391, PR-8b): guards
      // encadeados de recursos DIFERENTES (`patient_services:update` →
      // `vacancy:update`) ficavam com a 2ª invisível ao oráculo.
      cells: (route.cells ?? (route.cell ? [route.cell] : [])).map((c) => cellKey(c.resource, c.action)),
      status: registry.statusOfRoute(route),
    }));

    // ⚠️ `declaredCells` NÃO é `governedRoutes` filtrado: é a varredura INTEIRA,
    // que é exatamente o que `SyncPermissionCatalogUseCase` consome. Uma célula
    // declarada em rota FORA do perímetro (`/api/workers/me/*`, `/mcp/v1/*`,
    // webhook) entra no catálogo dos ambientes implantados e NÃO apareceria em
    // `governedRoutes` — um teste que usasse só aquela lista como oráculo daria
    // verde enquanto o catálogo real divergisse. Achado no gate do PR #244.
    const declaredCells = [
      ...new Set(routes.filter((r) => r.cell).map((r) => cellKey(r.cell!.resource, r.cell!.action))),
    ].sort();

    res.json({
      totalRoutes: routes.length,
      governedRoutes: governed,
      declaredCells,
      undeclared: registry.unexpectedlyUndeclared().map((route) => `${route.method} ${route.path}`),
    });
  });

  return router;
}
