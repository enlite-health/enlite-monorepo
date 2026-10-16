import { Router, Request, RequestHandler, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_USERS_FAMILY, exemptHandler } from '@modules/identity/permissions';
import { publicContextMiddleware } from '@shared/database/systemContextMiddleware';
import { TactiqLinkController } from '../controllers/TactiqLinkController';
import { TactiqCheckInternalController } from '../controllers/TactiqCheckInternalController';

/**
 * Rotas do vínculo do Tactiq (spec 049 F4). `/api/admin`, família `admin.users` (a mesma das células `own_*`).
 *
 * Células LITERAIS em cada rota (`celula-em-closure-nao-entra-no-catalogo`):
 *  - `own_tactiq_link:read`  — ver o estado do PRÓPRIO vínculo.
 *  - `own_tactiq_link:create` — iniciar a vinculação da PRÓPRIA conta.
 * `staffOnly` SEMPRE antes de `perm.require`.
 *
 * O callback NÃO entra aqui: é navegação do browser (sem Bearer) e usa `createTactiqLinkCallbackRoute` — a prova de
 * identidade é o `state` single-use criado pelo POST acima, que já passou pela célula `own_tactiq_link:create`.
 */
export function createTactiqLinkRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: TactiqLinkController,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_USERS_FAMILY);

  router.get(
    '/me/tactiq-link',
    staffOnly,
    perm.require('own_tactiq_link', 'read', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.getOwn(req, res),
  );

  router.post(
    '/me/tactiq-link',
    staffOnly,
    perm.require('own_tactiq_link', 'create', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.start(req, res),
  );

  return router;
}

/**
 * Callback do OAuth — SEM Bearer (navegação do browser), em contexto de banco público declarado. A isenção é declarada
 * na montagem (`exemptHandler`): o guard de rota sem célula a vê como `exempt`, não como `undeclared`.
 * `rateLimit` entra de fora (o `index.ts` tem o `express-rate-limit`); a prova de identidade é o `state` single-use.
 */
export function createTactiqLinkCallbackRoute(controller: TactiqLinkController, rateLimit: RequestHandler): Router {
  const router = Router();
  router.get(
    '/me/tactiq-link/callback',
    rateLimit,
    publicContextMiddleware('public:/api/admin/me/tactiq-link/callback'),
    exemptHandler('state single-use criado pelo POST autenticado (own_tactiq_link:create); callback é navegação do browser, sem Bearer'),
    (req: Request, res: Response) => controller.callback(req, res),
  );
  return router;
}

/** Job diário. Montado em `/api/internal` com contexto de sistema + segredo interno no `app.use`. */
export function createTactiqCheckInternalRoutes(controller: TactiqCheckInternalController): Router {
  const router = Router();
  router.post('/jobs/admission-tactiq-check', (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
