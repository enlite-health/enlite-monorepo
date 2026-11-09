/**
 * `GET /v1/persons/:pid/tree` — rota SERVIÇO A SERVIÇO (acesso-do-cliente F1, T138; contrato da spec B).
 *
 * Portão: o MESMO guard das rotas internas (`X-Internal-Secret` / Bearer OIDC — `internalAuthMiddleware`), injetado pelo
 * `index.ts`. Token de usuário final (Firebase) NÃO passa: a verificação OIDC o recusa (403). A classe `service` é marca
 * PROVISÓRIA até a F3, pelo mesmo mecanismo das rotas vizinhas (`exemptHandler`, como `GET /v1/me/areas`).
 */
import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { exemptHandler } from '../permissions/infrastructure/catalog/permissionMetadata';
import { PersonTreeController } from './controllers/PersonTreeController';

export function createPersonTreeRouter(serviceGuard: RequestHandler, pool: Pool): Router {
  const router = Router();
  const controller = new PersonTreeController(pool);
  const classeService = exemptHandler('service (marca provisória até a F3): serviço a serviço, guard OIDC/segredo interno');
  router.get('/persons/:pid/tree', serviceGuard, classeService, (req, res) => controller.tree(req, res));
  return router;
}
