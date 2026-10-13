import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_VACANCIES_FAMILY } from '@modules/identity/permissions';
import { EnquadreEventController } from '../controllers/EnquadreEventController';

/**
 * Rotas do evento de enquadre na vaga (spec 052, Fase 2). Montadas sob `/api/admin`, família `admin.vacancies`: a MESMA das
 * rotas da vaga onde a aba Enquadre vive (`adminVacanciesRoutes.ts`). `admin.encuadre` agrupa só rotas de worker/caso
 * (`workerEncuadreRoutes.ts`), não da vaga.
 *
 * Células LITERAIS em cada rota (nunca por variável/loop/closure — o scanner do catálogo só reconhece
 * `perm.require('recurso', 'ação', ...)` com strings literais):
 *  - `enquadre_event:read`   — lista e detalhe dos eventos.
 *  - `enquadre_event:create` — prestadores disponíveis, entrevistadoras, horários livres e criar o evento.
 * (`enquadre_event:update` e `enquadre_result:update` chegam com as mutações, T-30c.)
 * `staffOnly` SEMPRE antes de `perm.require`. Rotas ESTÁTICAS antes de `/:eventId` (senão o parâmetro as captura).
 */
export function createAdminEnquadreEventRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: EnquadreEventController,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_VACANCIES_FAMILY);

  router.get(
    '/vacancies/:vacancyId/enquadre-events',
    staffOnly,
    perm.require('enquadre_event', 'read'),
    (req: Request, res: Response) => controller.list(req, res),
  );

  router.get(
    '/vacancies/:vacancyId/enquadre-events/available-workers',
    staffOnly,
    perm.require('enquadre_event', 'create'),
    (req: Request, res: Response) => controller.availableWorkers(req, res),
  );

  router.get(
    '/vacancies/:vacancyId/enquadre-events/hosts',
    staffOnly,
    perm.require('enquadre_event', 'create'),
    (req: Request, res: Response) => controller.hosts(req, res),
  );

  router.get(
    '/vacancies/:vacancyId/enquadre-events/hosts/:hostId/free-slots',
    staffOnly,
    perm.require('enquadre_event', 'create'),
    (req: Request, res: Response) => controller.freeSlots(req, res),
  );

  router.get(
    '/vacancies/:vacancyId/enquadre-events/:eventId',
    staffOnly,
    perm.require('enquadre_event', 'read'),
    (req: Request, res: Response) => controller.get(req, res),
  );

  router.post(
    '/vacancies/:vacancyId/enquadre-events',
    staffOnly,
    perm.require('enquadre_event', 'create'),
    (req: Request, res: Response) => controller.create(req, res),
  );

  return router;
}
