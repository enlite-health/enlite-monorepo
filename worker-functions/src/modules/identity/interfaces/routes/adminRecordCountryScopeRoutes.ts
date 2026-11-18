/**
 * adminRecordCountryScopeRoutes — PONTO UNICO do escopo de pais para registro individual no /api/admin
 * (hotfix 18/11/2026: "dado do Brasil so para grupo com Brasil").
 *
 * Montado em index.ts ANTES de todos os routers de `/api/admin`, entao cobre `/patients/:id/*`, `/workers/:id/*` e
 * `/vacancies/:id/*` em QUALQUER router (fotos, conversa, documentos, itinerario, equipe, encuadres...), com os
 * nomes de param que o repo usa (`id`, `patientId`, `workerId`, `vacancyId`). Registro-pai fora do escopo do ator =>
 * 404 (nao confirma existencia). Id que nao e UUID (`stats`, `map`, `baja`...) passa direto, sem auth nem consulta;
 * id UUID passa antes por `requireStaffOrApiKey` (o guard precisa do uid; chave de servico passa direto).
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import { requireRecordInCountryScope, type GuardedTable } from '../middleware/recordCountryScopeGuard';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAdminRecordCountryScopeRoutes(authMiddleware: AuthMiddleware, getPool: () => Pool): Router {
  const router = Router();
  const auth = authMiddleware.requireStaffOrApiKey();

  const guarded = (table: GuardedTable, idParams: string[], notFoundBody: Record<string, unknown>): RequestHandler => {
    const guard = requireRecordInCountryScope(getPool, { table, idParams, notFoundBody });
    return (req: Request, res: Response, next: NextFunction) => {
      const id = idParams.map((p) => req.params[p]).find((v) => typeof v === 'string' && v.length > 0);
      if (!id || !UUID_RE.test(id)) return next();
      return auth(req, res, (err?: unknown) => (err ? next(err) : void guard(req, res, next)));
    };
  };

  router.use(['/patients/:id', '/patients/:patientId'], guarded('patients', ['id', 'patientId'], { success: false, error: 'Patient not found' }));
  router.use(['/workers/:id', '/workers/:workerId'], guarded('workers', ['id', 'workerId'], { success: false, error: 'Worker not found' }));
  router.use(['/vacancies/:id', '/vacancies/:vacancyId'], guarded('job_postings', ['id', 'vacancyId'], { success: false, error: 'Vacancy not found' }));
  return router;
}
