import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_USERS_FAMILY } from '@modules/identity/permissions';
import { InterviewHostController } from '../controllers/InterviewHostController';

/**
 * Rotas da tela Entrevistadores (spec 055). Montadas sob `/api/admin`. Família `admin.users` (agrupamento temático de gente do painel,
 * como `staff_directory`); as células são NOVAS e só do Acesso Master (migration 523).
 *
 * Células LITERAIS em cada rota (nunca por variável/loop/closure — o scanner do catálogo só reconhece `perm.require('recurso', 'ação')`
 * com strings literais). `staffOnly` SEMPRE antes de `perm.require`. A rota ESTÁTICA `/candidates` antes de `/:id`.
 */
export function createAdminInterviewHostRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: InterviewHostController,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_USERS_FAMILY);

  router.get('/interview-hosts', staffOnly, perm.require('interview_host', 'read'), (req: Request, res: Response) =>
    controller.list(req, res),
  );

  router.get('/interview-hosts/candidates', staffOnly, perm.require('interview_host', 'update'), (req: Request, res: Response) =>
    controller.candidates(req, res),
  );

  router.post('/interview-hosts', staffOnly, perm.require('interview_host', 'update'), (req: Request, res: Response) =>
    controller.create(req, res),
  );

  router.patch('/interview-hosts/:id', staffOnly, perm.require('interview_host', 'update'), (req: Request, res: Response) =>
    controller.patch(req, res),
  );

  return router;
}
