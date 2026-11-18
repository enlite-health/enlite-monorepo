/**
 * adminRecordCountryScopeRoutes — PONTO UNICO do escopo de pais para registro individual no /api/admin
 * (hotfix 18/11/2026: "dado do Brasil so para grupo com Brasil").
 *
 * Montado em index.ts ANTES de todos os routers de `/api/admin`, entao cobre `/patients/:id/*`, `/workers/:id/*` e
 * `/vacancies/:id/*` em QUALQUER router (fotos, conversa, documentos, itinerario, equipe, encuadres...), com os
 * nomes de param que o repo usa (`id`, `patientId`, `workerId`, `vacancyId`). Registro-pai fora do escopo do ator =>
 * 404 (nao confirma existencia). Id que nao e UUID (`stats`, `map`, `baja`...) passa direto, sem auth nem consulta;
 * id UUID passa antes por `requireStaffOrApiKey` (o guard precisa do uid; chave de servico passa direto); se a auth NAO passar, o guard nao responde e a rota por id nega como sempre (401/403 originais).
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
    return async (req: Request, res: Response, next: NextFunction) => {
      const id = idParams.map((p) => req.params[p]).find((v) => typeof v === 'string' && v.length > 0);
      if (!id || !UUID_RE.test(id)) return next();
      // O guard NAO e quem nega acesso: so recorta pais para quem ja e staff (ou chave de servico). Se a auth nao passar
      // (sem token, worker, role errada), a resposta do `res` e engolida e a request segue — a rota por id, que tem o proprio
      // `requireStaff`/`perm.require`, devolve o mesmo 401/403 de sempre (senao o guard trocaria 403 por 401).
      let authed: unknown = undefined;
      let passed = false;
      const mudo = new Proxy(res, {
        get(target, prop, receiver) {
          if (prop === 'status' || prop === 'set' || prop === 'setHeader' || prop === 'type') return () => mudo;
          if (prop === 'json' || prop === 'send' || prop === 'end' || prop === 'sendStatus') return () => mudo;
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      await auth(req, mudo, (err?: unknown) => { passed = true; authed = err; });
      if (!passed) return next();
      if (authed) return next(authed);
      return guard(req, res, next);
    };
  };

  router.use(['/patients/:id', '/patients/:patientId'], guarded('patients', ['id', 'patientId'], { success: false, error: 'Patient not found' }));
  router.use(['/workers/:id', '/workers/:workerId'], guarded('workers', ['id', 'workerId'], { success: false, error: 'Worker not found' }));
  router.use(['/vacancies/:id', '/vacancies/:vacancyId'], guarded('job_postings', ['id', 'vacancyId'], { success: false, error: 'Vacancy not found' }));
  return router;
}
