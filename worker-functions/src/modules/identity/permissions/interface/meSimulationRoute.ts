/**
 * src/modules/identity/permissions/interface/meSimulationRoute.ts
 *
 * `/v1/me/simulation*` — spec 026 (D407), contrato
 * `specs/026-simular-grupo-de-acesso/contracts/me-simulation.md`. Molde EXATO
 * de `meAuthzRoute.ts`: `staffGuard` é o ÚNICO portão (`exemptHandler` marca
 * cada rota isenta de célula — self não é decisão de staff, D116), uid/tenantId
 * vêm SÓ do principal autenticado (nunca de body/query — não existe
 * `POST /v1/users/:uid/simulation` aqui).
 *
 * A invariante "só o Acesso Master simula" é do BANCO
 * (`iam.start_group_simulation`/`iam.is_master_member`, mig 458) — esta rota só
 * TRADUZ o `PermissionError` que já sobe traduzido pelo `toPermissionError`
 * existente (nenhuma linha nova no mapeador, spec 026 F2):
 *   · `forbidden`               → 403 `{ code: 'not_master_member' }`
 *   · `not_found`/`system_group` → 422 `{ code: 'group_not_simulable' }`
 *   · qualquer outro erro        → 500 (fail-closed, mesmo molde de `meAuthzRoute`)
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { isPermissionError, toPermissionError } from '../domain/PermissionError';
import { ENLITE_TENANT_ID } from '../domain/tenant';
import { exemptHandler } from '../infrastructure/catalog/permissionMetadata';
import type { EndGroupSimulationUseCase } from '../application/EndGroupSimulationUseCase';
import type { ListSimulatableGroupsUseCase } from '../application/ListSimulatableGroupsUseCase';
import type { PermissionClient } from '../application/ports';
import type { StartGroupSimulationUseCase } from '../application/StartGroupSimulationUseCase';

export interface MeSimulationRouterDeps {
  listGroups: ListSimulatableGroupsUseCase;
  startSimulation: StartGroupSimulationUseCase;
  endSimulation: EndGroupSimulationUseCase;
  /**
   * `permissions.client` (o `PermissionService` cacheado, TTL 30s) — só para
   * ler `canSimulate` no `GET /groups` (D407: `iam.permission_groups` não tem
   * RLS de Master; sem este gate, QUALQUER staff listaria os grupos
   * simuláveis). Reusa o MESMO resolvedor cacheado de `/v1/me/authz` — nenhuma
   * query nova, nenhum SQL próprio aqui.
   */
  client: Pick<PermissionClient, 'resolve'>;
  /** `authMiddleware.requireStaff()` da casa — mesmo papel do `meAuthzRoute.ts`. */
  staffGuard: RequestHandler;
  /** Extração do uid do principal — a MESMA do `PermissionMiddleware`. */
  uidOf: (req: Request) => string | null;
  tenantId?: string;
}

const StartBody = z.object({ groupId: z.string().uuid() });

/** Traduz o `PermissionError` já mapeado pelo `toPermissionError` existente — vocabulário DESTA rota. */
function respondPermissionError(res: Response, err: unknown): boolean {
  const perm = isPermissionError(err) ? err : toPermissionError(err);
  if (!isPermissionError(perm)) return false;
  if (perm.code === 'forbidden') {
    res.status(403).json({ code: 'not_master_member' });
    return true;
  }
  if (perm.code === 'not_found' || perm.code === 'system_group') {
    res.status(422).json({ code: 'group_not_simulable' });
    return true;
  }
  return false;
}

export function createMeSimulationRouter(deps: MeSimulationRouterDeps): Router {
  const router = Router();
  const tenantId = deps.tenantId ?? ENLITE_TENANT_ID;

  // A isenção é DECLARADA na montagem, como em `meAuthzRoute.ts:57` — é a marca
  // que põe cada rota no perímetro (`isGovernedRoute`) como `exempt`, sem linha
  // em `GOVERNED_ROUTES`/`EXEMPT_ROUTES`.
  const isentaGroups = exemptHandler('self (D407): o Acesso Master simulando é decisão do próprio ator sobre si mesmo');
  const isentaStart = exemptHandler('self (D407): abrir simulação é ato do próprio Acesso Master sobre si mesmo');
  const isentaEnd = exemptHandler('self (D407): encerrar a própria simulação é sempre permitido, sem célula');

  router.get('/me/simulation/groups', deps.staffGuard, isentaGroups, async (req, res) => {
    const uid = deps.uidOf(req);
    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }
    try {
      // `iam.permission_groups` não tem RLS por Master — o gate é aqui, com o
      // MESMO `canSimulate` que `/v1/me/authz` já resolve e cacheia (D407).
      const resolved = await deps.client.resolve(uid, tenantId);
      if (!resolved.canSimulate) {
        res.status(403).json({ code: 'not_master_member' });
        return;
      }
      res.json(await deps.listGroups.execute({ tenantId }));
    } catch (err) {
      if (respondPermissionError(res, err)) return;
      logger.error({ err, uid }, '[perm] falha ao listar grupos simuláveis');
      res.status(500).json({ success: false, error: 'Failed to list simulatable groups' });
    }
  });

  router.post('/me/simulation', deps.staffGuard, isentaStart, async (req, res) => {
    const uid = deps.uidOf(req);
    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }
    const body = StartBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid simulation payload' });
      return;
    }
    try {
      const simulation = await deps.startSimulation.execute({ uid, tenantId, groupId: body.data.groupId });
      res.status(201).json(simulation);
    } catch (err) {
      if (respondPermissionError(res, err)) return;
      logger.error({ err, uid }, '[perm] falha ao abrir simulação de grupo');
      res.status(500).json({ success: false, error: 'Failed to start simulation' });
    }
  });

  router.delete('/me/simulation', deps.staffGuard, isentaEnd, async (req, res) => {
    const uid = deps.uidOf(req);
    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }
    try {
      await deps.endSimulation.execute({ uid, tenantId });
      res.status(204).end();
    } catch (err) {
      if (respondPermissionError(res, err)) return;
      logger.error({ err, uid }, '[perm] falha ao encerrar simulação de grupo');
      res.status(500).json({ success: false, error: 'Failed to end simulation' });
    }
  });

  return router;
}
