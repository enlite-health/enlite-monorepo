/**
 * adminRecordCountryScopeRoutes — PONTO UNICO do escopo de pais para registro individual no /api/admin
 * (hotfix 18/11/2026: "dado do Brasil so para grupo com Brasil").
 *
 * Montado em index.ts como o PRIMEIRO mount de rota (travado por adminRecordCountryScopeMountOrder.test.ts): cobre
 * `/patients/:id/*`, `/workers/:id/*` e `/vacancies/:id/*` em QUALQUER router sob `/api/admin` (inclusive os montados em
 * `/api`), com os nomes de param que o repo usa (`id`, `patientId`, `workerId`, `vacancyId`). Registro-pai fora do escopo do
 * ator => 404 (nao confirma existencia). Id que nao e UUID (`stats`, `map`, `baja`...) passa direto, sem auth nem consulta.
 *
 * AUTENTICACAO — a MESMA regra das rotas (bloqueio do gate no 1b509b14e: o guard so lia `Authorization: Bearer` e as rotas
 * (`requireStaff` -> `requireAuth` -> `MultiAuthService.parseCredentials`) tambem aceitam `x-google-id-token`; falhar em
 * silencio e seguir deixava um staff so-AR ler BR por esse header). Aqui a decisao vem de `requireAuth()` — a mesma
 * funcao das rotas, com o mesmo `parseCredentials` — rodando contra um `res` FALSO (`MudoRes`) que so registra; o `res`
 * real nunca e tocado pela auth. Resultado -> comportamento:
 *   autenticou, staff            -> recorte de pais (404 fora do escopo; 403 COUNTRY_SCOPE_REQUIRED sem pais)
 *   autenticou, nao-staff        -> next(): a rota por id nega (403) como sempre
 *   chave de servico (Bearer)    -> next() (kind=system: decisao pendente, politica de hoje)
 *   nao autenticou (sem/ruim)    -> FAIL-CLOSED: replica a resposta que a rota daria (401), nunca next()
 *   excecao/erro de infra        -> FAIL-CLOSED: 500 (do requireAuth) ou 500 do guard, nunca next()
 * Por que nao `next()` quando nao autenticou: o Firebase strategy engole falha de infra como `null` (=> 401), entao
 * "credencial invalida" e "Firebase fora" sao indistinguiveis aqui; deixar passar abriria uma janela (a rota reautentica
 * e pode acertar no 2o try). Fechar custa so repetir o 401 que a rota daria de qualquer forma.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import { requireRecordInCountryScope, type GuardedTable } from '../middleware/recordCountryScopeGuard';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `res` falso e dedicado: registra TODA escrita (status, corpo, header, qualquer metodo) e nao toca o `res` real. */
export class MudoRes {
  statusCode = 200;
  body: unknown = undefined;
  headers: Record<string, unknown> = {};
  headersSent = false;
  written = false;
  readonly calls: string[] = [];
  locals: Record<string, unknown> = {};

  constructor() {
    // Qualquer metodo de `Response` que a auth chame e que nao esteja aqui e registrado (e devolve `this`) em vez de estourar.
    return new Proxy(this, {
      get: (t, prop, recv) => {
        if (prop in t || typeof prop === 'symbol') return Reflect.get(t, prop, recv);
        return (...args: unknown[]) => { t.calls.push(String(prop)); void args; t.written = true; return recv; };
      },
    });
  }
  status(code: number): this { this.statusCode = code; this.calls.push('status'); return this; }
  json(b: unknown): this { this.body = b; this.written = true; this.calls.push('json'); return this; }
  send(b?: unknown): this { this.body = b; this.written = true; this.calls.push('send'); return this; }
  end(b?: unknown): this { this.body = b; this.written = true; this.calls.push('end'); return this; }
  set(k: string, v: unknown): this { this.headers[k] = v; this.calls.push('set'); return this; }
  setHeader(k: string, v: unknown): this { this.headers[k] = v; this.calls.push('setHeader'); return this; }
  header(k: string, v: unknown): this { return this.setHeader(k, v); }
  getHeader(k: string): unknown { return this.headers[k]; }
  type(t: string): this { this.headers['content-type'] = t; return this; }
}

/** Roda um middleware de auth contra o `MudoRes`; diz se a request passou (chamou next) e o que ele tentou responder. */
async function rodar(mw: RequestHandler, req: Request): Promise<{ passou: boolean; err?: unknown; mudo: MudoRes }> {
  const mudo = new MudoRes();
  let passou = false;
  let err: unknown;
  await mw(req, mudo as unknown as Response, (e?: unknown) => { passou = true; err = e; });
  return { passou, err, mudo };
}

function replicar(res: Response, mudo: MudoRes): void {
  if (res.headersSent) return;
  res.status(mudo.statusCode >= 400 ? mudo.statusCode : 500);
  if (mudo.body === undefined) res.end();
  else res.json(mudo.body);
}

export function createAdminRecordCountryScopeRoutes(authMiddleware: AuthMiddleware, getPool: () => Pool): Router {
  const router = Router();
  const authRota = authMiddleware.requireAuth(); // a mesma que `requireStaff` usa por dentro (mesmo parseCredentials)
  const authChave = authMiddleware.requireStaffOrApiKey(); // Bearer = chave de servico (kind=system)

  const guarded = (table: GuardedTable, idParams: string[], notFoundBody: Record<string, unknown>): RequestHandler => {
    const guard = requireRecordInCountryScope(getPool, { table, idParams, notFoundBody });
    return async (req: Request, res: Response, next: NextFunction) => {
      const id = idParams.map((p) => req.params[p]).find((v) => typeof v === 'string' && v.length > 0);
      if (!id || !UUID_RE.test(id)) return next();
      try {
        let r = await rodar(authRota, req);
        if (!r.passou) {
          // Bearer com chave de servico nao e credencial do requireAuth (ele a tenta como Firebase): tenta o atalho de chave.
          const chave = await rodar(authChave, req);
          if (chave.passou && !chave.err) return guard(req, res, next); // kind=system => o guard deixa passar
          return replicar(res, r.mudo.written ? r.mudo : chave.mudo); // FAIL-CLOSED: nunca next() sem autenticar
        }
        if (r.err) return next(r.err);
        return guard(req, res, next); // staff => recorte; nao-staff/system => o guard passa e a rota nega
      } catch (e) {
        return next(e); // rejeicao nunca pendura a request; o handler de erro do app responde (5xx)
      }
    };
  };

  router.use(['/patients/:id', '/patients/:patientId'], guarded('patients', ['id', 'patientId'], { success: false, error: 'Patient not found' }));
  router.use(['/workers/:id', '/workers/:workerId'], guarded('workers', ['id', 'workerId'], { success: false, error: 'Worker not found' }));
  router.use(['/vacancies/:id', '/vacancies/:vacancyId'], guarded('job_postings', ['id', 'vacancyId'], { success: false, error: 'Vacancy not found' }));
  return router;
}
