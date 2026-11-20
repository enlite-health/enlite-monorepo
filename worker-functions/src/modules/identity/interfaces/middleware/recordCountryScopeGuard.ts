/**
 * recordCountryScopeGuard — fabrica UNICA do guard "registro individual fora do escopo de pais => 404".
 *
 * Regra (Gabriel, 18/11/2026): dado do Brasil so para grupo com Brasil. `COUNTRY_RLS_ENABLED=false` => o banco nao
 * recorta; o recorte e da aplicacao. Le o `country` do registro-pai (tabela da whitelist `GUARDED_TABLES`, nunca
 * entrada do request) e responde 404 — nao 403: nao confirma que o registro existe. O escopo vem de
 * `resolveCountryScope` (um dono: `iam.effective_countries`); sem pais => 403 COUNTRY_SCOPE_REQUIRED.
 *
 * Montar com `router.use(paths, requireStaffOrApiKey(), guard)` (chave de servico passa direto; nunca 403 por causa do guard) ANTES das rotas por id (precisa do uid do requireStaff).
 * Id que nao e UUID passa direto (o handler devolve o 400 de sempre; nenhum dado sai). Id inexistente passa
 * (o handler responde o 404 dele — mesma resposta do fora-de-escopo). Falha ao decidir => 500 fechado.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { resolveCountryScope, CountryScopeError } from '../../application/resolveCountryScope';
import { currentDbContext } from '@shared/database/requestDbSession';
import { reportError } from '@shared/logging';

/** Whitelist: o nome da tabela entra na SQL, entao NUNCA vem do request. */
const GUARDED_TABLES = ['patients', 'workers', 'job_postings'] as const;
export type GuardedTable = (typeof GUARDED_TABLES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecordCountryScopeOptions {
  table: GuardedTable;
  /** Nomes dos params de rota que carregam o id do registro-pai (o primeiro presente vale). */
  idParams: readonly string[];
  /** Corpo do 404 — o MESMO que o handler devolve para "nao existe". */
  notFoundBody: Record<string, unknown>;
}

export function requireRecordInCountryScope(getPool: () => Pool, opts: RecordCountryScopeOptions): RequestHandler {
  if (!GUARDED_TABLES.includes(opts.table)) throw new Error(`recordCountryScopeGuard: tabela fora da whitelist: ${opts.table}`);
  const sql = `SELECT country FROM ${opts.table} WHERE id = $1`;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Principal de servico (API key, kind=system) nao tem uid/pais: nao e decidido aqui — DECISAO PENDENTE (PR).
    if (currentDbContext()?.kind !== 'staff') return next();
    const id = opts.idParams.map((p) => req.params[p]).find((v) => typeof v === 'string' && v.length > 0);
    if (!id || !UUID_RE.test(id)) return next();

    try {
      const db = getPool();
      const scope = await resolveCountryScope(db, currentDbContext()?.uid, undefined);
      const { rows } = await db.query<{ country: string | null }>(sql, [id]);
      if (rows.length === 0) return next();
      if (!(scope.countries as string[]).includes(String(rows[0].country ?? '').trim())) {
        res.status(404).json(opts.notFoundBody);
        return;
      }
      next();
    } catch (err) {
      if (err instanceof CountryScopeError) {
        res.status(err.status).json({ success: false, error: err.code, detail: err.message });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: `recordCountryScopeGuard:${opts.table}` });
      res.status(500).json({ success: false, error: 'Failed to resolve country scope' });
    }
  };
}
