/**
 * `GET /v1/persons/:pid/tree` — rota SERVIÇO A SERVIÇO (acesso-do-cliente F1, T138; contrato da spec B).
 *
 * Portão: `requirePersonTreeService` (X-Internal-Secret, ou Bearer OIDC com SA na allowlist `PERSON_TREE_ALLOWED_SAS`,
 * fail-closed), injetado pelo `index.ts`. Token de usuário final (Firebase) NÃO passa: a verificação OIDC o recusa (403). Classe `service` declarada por `routeClass` (F3).
 */
import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { routeClass } from '../permissions/infrastructure/catalog/routeClass';
import { PersonTreeController } from './controllers/PersonTreeController';

export function createPersonTreeRouter(serviceGuard: RequestHandler, pool: Pool): Router {
  const router = Router();
  const controller = new PersonTreeController(pool);
  const classeService = routeClass('service');
  router.get('/persons/:pid/tree', serviceGuard, classeService, (req, res) => controller.tree(req, res));
  return router;
}
