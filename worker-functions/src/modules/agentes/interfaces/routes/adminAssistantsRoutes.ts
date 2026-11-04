import { Router, Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { principalUid, CountryScopeError } from '@modules/identity';
import { requireCountryScope } from '@modules/identity/interfaces/middleware/countryScopeGuard';
import {
  ADMIN_INTEGRATIONS_FAMILY,
  ADMIN_PATIENTS_FAMILY,
  ADMIN_VACANCIES_FAMILY,
  ADMIN_WORKERS_FAMILY,
  exemptHandler,
} from '@modules/identity/permissions';
import { staffActor } from '@shared/audit/actorSource';
import type { CountryCode } from '@shared/domain/countryCodes';
import { logger } from '@shared/logging';
import type { AssistantCountService } from '../../application/AssistantCountService';
import type { CountEntity } from '../../domain/assistantCountMenu';
import { requireAssistantsService } from '../middleware/requireAssistantsService';
import { AssistantsPlatformController } from '../controllers/AssistantsPlatformController';

/**
 * /api/admin/assistants/reach, /api/admin/assistants/scoreboard, /api/admin/assistants/escalations — spec 080, contract
 * `rotas-plataforma-novas.md` §1-§3. TWO identities on all of them: service (`X-Enlite-Service`) -> person (`requireStaff`)
 * -> cell. The array order is the contract; `perm.require` always in the ARRAY, never in a closure.
 * Reach asks for no cell (it describes the actor itself: `req.permissionCells` only exists inside `perm.require`).
 */
/** Contagem por cardápio (change 085): o serviço e o resolvedor de países do ator (o mesmo de `/patients/stats`). */
export interface AssistantCountDeps {
  service: AssistantCountService;
  resolveCountries: (uid: string, requested: unknown) => Promise<CountryCode[]>;
}

/** Nunca loga o corpo/filtros: só entidade e status. */
function countHandler(entity: CountEntity, deps: AssistantCountDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const uid = principalUid(req);
    if (!uid) return void res.status(401).json({ error: 'Unauthenticated' });
    let filters: unknown;
    if (req.query.filters !== undefined) {
      try {
        filters = JSON.parse(String(req.query.filters));
      } catch {
        return void res.status(400).json({ error: 'invalid_request', message: 'filters debe ser JSON válido' });
      }
    }
    try {
      const countries = await deps.resolveCountries(uid, req.query.country);
      const out = await deps.service.count(entity, { filters, group_by: req.query.group_by }, staffActor(uid)!, countries);
      if (!out.ok) return void res.status(out.status).json(out.error);
      res.status(200).json(out.response);
    } catch (err) {
      if (err instanceof CountryScopeError) return void res.status(err.status).json({ error: err.code });
      logger.error({ entity, error: err instanceof Error ? err.name : 'error' }, '[assistants] count failed');
      res.status(500).json({ error: 'COUNT_FAILED' });
    }
  };
}

export function createAdminAssistantsRoutes(
  controller: AssistantsPlatformController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  counts?: AssistantCountDeps,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

  router.get('/assistants/reach', requireAssistantsService(), staffOnly, exemptHandler('self: describes the actor itself for the assistants service; requireStaff is the gate'), (req: Request, res: Response) => controller.reach(req, res));
  router.get('/assistants/scoreboard', requireAssistantsService(), staffOnly, perm.require('assistant_scoreboard', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.scoreboard(req, res));
  router.post('/assistants/escalations', requireAssistantsService(), staffOnly, perm.require('assistant_escalation', 'register', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.escalate(req, res));

  if (counts) {
    // DD2: a MESMA família e célula da lista de cada entidade; tudo no array, nunca em closure (F-db-8).
    const permWorkers = permissions.family(ADMIN_WORKERS_FAMILY);
    const permPatients = permissions.family(ADMIN_PATIENTS_FAMILY);
    const permVacancies = permissions.family(ADMIN_VACANCIES_FAMILY);
    const countryScope = requireCountryScope();
    router.get('/assistants/count/workers', requireAssistantsService(), staffOnly, permWorkers.require('worker', 'read'), countryScope, countHandler('workers', counts));
    router.get('/assistants/count/patients', requireAssistantsService(), staffOnly, permPatients.require('patient', 'read'), countryScope, countHandler('patients', counts));
    router.get('/assistants/count/vacancies', requireAssistantsService(), staffOnly, permVacancies.require('vacancy', 'read'), countryScope, countHandler('vacancies', counts));
  }

  return router;
}
