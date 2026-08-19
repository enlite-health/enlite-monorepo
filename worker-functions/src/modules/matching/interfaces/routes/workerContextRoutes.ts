import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { WorkerContextController } from '../controllers/WorkerContextController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_WORKERS_FAMILY } from '@modules/worker/interfaces/routes/adminWorkerRoutes';

/**
 * @deprecated Rotas legadas para o triage-service. Substituídas pelo MCP server
 * (montado em /mcp/v1 quando `MCP_ENABLED=true`). Mantidas enquanto o triage
 * tiver `USE_MCP_GATEWAY=false` (default). Remoção física: ver
 * docs/SPRINT_MCP_INTERNAL_SERVER.md §4.x — PR 8 do sprint.
 */

/**
 * Rate limit análogo ao workerLookupRateLimit de index.ts: 5 req/min.
 * Ingest de documentos é operação cara — limite conservador.
 *
 * keyGenerator usa workerId (req.params.id) quando disponível.
 * Cloud Run atrás de LB pode ter todos requests com o mesmo IP,
 * tornando o limit por IP efetivamente global — por workerId é correto.
 */
/**
 * Extraída (task 3.5-A1) só para ser TESTÁVEL: o `express-rate-limit` não expõe
 * o `keyGenerator` no handler montado, então inline ela é inalcançável por
 * teste. Comportamento idêntico ao de antes — nenhuma linha mudou de sentido.
 *
 * ⚠️ Dívida NÃO tocada aqui (achado do PR A1, fora do escopo dele): o
 * `express-rate-limit` acusa `ERR_ERL_KEY_GEN_IPV6` neste fallback — usar
 * `req.ip` sem o helper `ipKeyGenerator` deixa cliente IPv6 furar o limite,
 * porque cada endereço de um mesmo /64 vira uma chave diferente. Só alcança o
 * ramo SEM `workerId`, que na prática não existe (a rota tem `:id` no path).
 * Conserto é PR próprio, junto com o mesmo aviso já registrado em `account-link`.
 */
export function ingestRateLimitKey(req: Request): string {
  const workerId = (req.params as Record<string, string> | undefined)?.id;
  if (workerId) return `worker:${workerId}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

const ingestRateLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
  keyGenerator: ingestRateLimitKey,
});

/**
 * createWorkerContextRoutes
 *
 * Endpoints do triage-service (MCP internal):
 *   GET  /workers/:id/current-interview
 *   GET  /workers/:id/available-vacancies
 *   POST /workers/:id/documents/ingest-from-url
 *
 * Todos protegidos por requireStaffOrApiKey (API key OU staff Firebase).
 * Registrar em index.ts com: app.use('/api/admin', createWorkerContextRoutes(...))
 *
 * Parte da família `admin.workers` (task 3.5) — as 3 rotas vivem sob
 * `/api/admin/workers/:id/*` e viram junto com as outras 28.
 *
 * ⚠️ ESTAS SÃO AS ROTAS DA LUZ. O chamador real é o triage-service por chave de
 * API, cujo principal é `service:<nome>` e não existe em `users` — sem o desvio
 * de principal de serviço no `PermissionMiddleware`, ligar esta família em
 * `PERMISSION_ENFORCED_ROUTES` derrubaria a Luz em produção com 403. A célula é
 * declarada mesmo assim: quando quem chama é um STAFF pela mesma rota, a
 * decisão é do grupo dele.
 */
export function createWorkerContextRoutes(
  controller: WorkerContextController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const auth = authMiddleware.requireStaffOrApiKey();
  const perm = permissions.family(ADMIN_WORKERS_FAMILY);

  router.get(
    '/workers/:id/current-interview',
    auth,
    perm.require('interview', 'read'),
    (req: Request, res: Response) => controller.currentInterview(req, res),
  );

  router.get(
    '/workers/:id/available-vacancies',
    auth,
    perm.require('vacancy', 'read'),
    (req: Request, res: Response) => controller.availableVacancies(req, res),
  );

  router.post(
    '/workers/:id/documents/ingest-from-url',
    auth,
    perm.require('worker_document', 'write'),
    ingestRateLimit,
    (req: Request, res: Response) => controller.ingestFromUrl(req, res),
  );

  return router;
}
