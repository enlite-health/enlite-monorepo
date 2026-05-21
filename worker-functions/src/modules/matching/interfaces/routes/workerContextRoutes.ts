import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { WorkerContextController } from '../controllers/WorkerContextController';
import { AuthMiddleware } from '@modules/identity';

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
const ingestRateLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
  keyGenerator: (req: Request) => {
    const workerId = (req.params as Record<string, string> | undefined)?.id;
    if (workerId) return `worker:${workerId}`;
    return `ip:${req.ip ?? 'unknown'}`;
  },
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
 */
export function createWorkerContextRoutes(
  controller: WorkerContextController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const auth = authMiddleware.requireStaffOrApiKey();

  router.get(
    '/workers/:id/current-interview',
    auth,
    (req: Request, res: Response) => controller.currentInterview(req, res),
  );

  router.get(
    '/workers/:id/available-vacancies',
    auth,
    (req: Request, res: Response) => controller.availableVacancies(req, res),
  );

  router.post(
    '/workers/:id/documents/ingest-from-url',
    auth,
    ingestRateLimit,
    (req: Request, res: Response) => controller.ingestFromUrl(req, res),
  );

  return router;
}
