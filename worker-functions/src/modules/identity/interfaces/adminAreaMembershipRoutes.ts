import { Router, Request, Response } from 'express';
import type { AuthMiddleware } from './middleware/AuthMiddleware';
import type { PermissionMiddleware } from './middleware/PermissionMiddleware';
import { ADMIN_USERS_FAMILY } from '@modules/identity/permissions';

/**
 * Rotas de staff do registro de vínculos de área (design §3 "Rotas de staff"; change
 * acesso-do-cliente-areas-e-login-unico, T111). Montada sob `/api/admin`.
 *
 * Contrato (T113): GET/POST `/area-memberships` e POST `/area-memberships/:id/revoke`; handlers = `AreaMembershipController`
 * (T111). Sem handlers injetados, cada rota responde 501 (o teste de contrato de rotas monta o router assim). Famílias/células: `admin.users` (agrupamento temático,
 * mesmo molde de `adminStaffDirectoryRoutes.ts`); células LITERAIS no `perm.require`, nunca em variável/closure
 * (`celula-em-closure-nao-entra-no-catalogo`). `staffOnly` SEMPRE antes de `perm.require`.
 *
 * Nenhum grupo recebe a célula por migration — conceder é ato da operação.
 */
export interface AreaMembershipHandlers {
  list(req: Request, res: Response): unknown;
  grant(req: Request, res: Response): unknown;
  revoke(req: Request, res: Response): unknown;
}

const notImplemented = (_req: Request, res: Response) => {
  res.status(501).json({ error: 'not_implemented' });
};

const NOT_IMPLEMENTED_HANDLERS: AreaMembershipHandlers = {
  list: notImplemented,
  grant: notImplemented,
  revoke: notImplemented,
};

export function createAdminAreaMembershipRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  handlers: AreaMembershipHandlers = NOT_IMPLEMENTED_HANDLERS,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_USERS_FAMILY);

  router.get('/area-memberships', staffOnly, perm.require('area_membership', 'read'), (req: Request, res: Response) =>
    handlers.list(req, res),
  );
  router.post('/area-memberships', staffOnly, perm.require('area_membership', 'write'), (req: Request, res: Response) =>
    handlers.grant(req, res),
  );
  router.post(
    '/area-memberships/:id/revoke',
    staffOnly,
    perm.require('area_membership', 'write'),
    (req: Request, res: Response) => handlers.revoke(req, res),
  );

  return router;
}
