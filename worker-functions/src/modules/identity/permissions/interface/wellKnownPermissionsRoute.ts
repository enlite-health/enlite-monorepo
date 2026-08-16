/**
 * src/modules/identity/permissions/interface/wellKnownPermissionsRoute.ts
 *
 * `GET /.well-known/permissions` — o catálogo DESTE serviço, publicado para o
 * agregador futuro (D115 §7, amarra de extração: cada serviço declara as suas
 * células e o painel junta tudo). Modelo: Backstage
 * (`/.well-known/…/permission/metadata`).
 *
 * (lex C14) AUTENTICADO. A lista expõe topologia — `worker_pii:read`,
 * `dedup:execute`, `patient:delete` contam o que o sistema faz e onde estão as
 * ações destrutivas. Quem consome é serviço, e serviço carrega credencial; o
 * guard vem INJETADO pelo wiring (o mesmo `internalAuthMiddleware` das rotas
 * internas) em vez de re-implementado aqui — o módulo não conhece o esquema de
 * autenticação da casa, e assim não há duas cópias da regra para divergir.
 */

import { Router, type RequestHandler } from 'express';
import { cellKey } from '../domain/PermissionCell';
import type { ListPermissionCatalogUseCase } from '../application/ListPermissionCatalogUseCase';

export interface WellKnownPermissionsOptions {
  ownerService: string;
}

export function createWellKnownPermissionsRouter(
  listCatalog: ListPermissionCatalogUseCase,
  guard: RequestHandler,
  options: WellKnownPermissionsOptions,
): Router {
  const router = Router();

  router.get('/permissions', guard, async (_req, res) => {
    const categories = await listCatalog.execute({ includeDeprecated: true });
    res.json({
      service: options.ownerService,
      permissions: categories.flatMap((category) =>
        category.cells.map((cell) => ({
          key: cellKey(cell.resource, cell.action),
          resource: cell.resource,
          action: cell.action,
          category: category.category,
          ownerService: cell.ownerService,
          deprecated: cell.deprecatedAt !== null && cell.deprecatedAt !== undefined,
        })),
      ),
    });
  });

  return router;
}
