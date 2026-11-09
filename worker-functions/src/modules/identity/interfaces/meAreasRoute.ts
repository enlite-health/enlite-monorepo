/**
 * `GET /v1/me/areas` — descoberta única das áreas da pessoa (design §3, DF-5, D644/D647, AJUSTE A2).
 *
 * Sem célula, de propósito: descreve o PRÓPRIO ator para ele mesmo (o uid vem do principal autenticado, nunca de
 * path/query — não há IDOR). A classe `client-policy` é marca PROVISÓRIA até a F3 (declarada pela isenção, como
 * `GET /v1/me/authz`), quando o motor do cliente passa a decidir.
 *
 * Por chamada: (1) `iam.ensure_person` — pessoa do login (bootstrap cria pessoa + login; conta removida → 401);
 * (2) `ListPersonAreasUseCase` com o principal de `req.user` (o MESMO que o portão de staff avalia, V1);
 * (3) reconciliação: o claim `pid`+`areas` do Firebase é comparado ao plano recalculado (`planAreasClaims`) e, se diferir,
 * regravado em cada login vivo (`applyAreasClaims`) com `tokenRefreshRequired: true` — o servidor não força o refresh
 * (`revokeRefreshTokens` desloga); a web faz `getIdToken(true)` ao ver a flag.
 * Falha na reconciliação NÃO derruba a descoberta: a lista sai correta, sem a flag, e o erro vai ao log (sem PII).
 */
import * as admin from 'firebase-admin';
import { Router, type Request, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { routeClass } from '../permissions/infrastructure/catalog/routeClass';
import { ListPersonAreasUseCase } from '../application/ListPersonAreasUseCase';
import { PgAreaRegistryRepository } from '../infrastructure/PgAreaRegistryRepository';
import { PgAreaMembershipRepository } from '../infrastructure/PgAreaMembershipRepository';
import { applyAreasClaims, planAreasClaims, type AreasClaim } from '../infrastructure/areasClaim';

function sameAreas(a: unknown, b: AreasClaim): boolean {
  if (!a || typeof a !== 'object') return false;
  const left = a as Record<string, unknown>;
  const keys = Object.keys(b);
  return (
    Object.keys(left).length === keys.length &&
    keys.every((k) => Array.isArray(left[k]) && JSON.stringify([...(left[k] as string[])].sort()) === JSON.stringify([...b[k]].sort()))
  );
}

export function createMeAreasRouter(requireAuth: RequestHandler, pool: Pool): Router {
  const router = Router();
  const registry = new PgAreaRegistryRepository(pool);
  const directory = new PgAreaMembershipRepository(pool);
  const listAreas = new ListPersonAreasUseCase(registry);
  const classe = routeClass('client-policy');

  async function reconcile(uid: string, pid: string): Promise<boolean> {
    const planned = await planAreasClaims(pid, registry, directory);
    if (planned.isFailure) throw new Error(planned.error as string);
    const { uids, plan } = planned.getValue();
    const mine = plan.find((e) => e.uid === uid);
    if (!mine) return false;
    const current = ((await admin.auth().getUser(uid)).customClaims ?? {}) as Record<string, unknown>;
    if (current.pid === mine.patch.pid && sameAreas(current.areas, mine.patch.areas)) return false;
    const { failedUids } = await applyAreasClaims(uids, plan, { revokeTokens: false });
    return !failedUids.includes(uid);
  }

  router.get('/me/areas', requireAuth, classe, async (req: Request, res) => {
    const principal = (req as { user?: { uid?: string; roles?: string[]; accountType?: string | null } }).user;
    const uid = principal?.uid;
    if (!uid) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    try {
      const pid = await registry.ensurePerson(uid);
      if (!pid) {
        res.status(401).json({ success: false, error: 'Login removido' });
        return;
      }
      const listed = await listAreas.execute({ principal: principal as NonNullable<typeof principal>, pid });
      if (listed.isFailure) throw new Error(listed.error as string);
      let tokenRefreshRequired = false;
      try {
        tokenRefreshRequired = await reconcile(uid, pid);
      } catch (error) {
        logger.error({ err: error }, '[me/areas] reconciliação do claim falhou; a lista segue correta');
      }
      res.json({ areas: listed.getValue(), tokenRefreshRequired });
    } catch (error) {
      logger.error({ err: error }, '[me/areas] falha ao resolver as áreas');
      res.status(500).json({ success: false, error: 'Falha ao resolver as áreas' });
    }
  });

  return router;
}
