/**
 * patientCountryScopeGuard — PONTO UNICO de checagem de pais para tudo sob `/patients/:id/*`.
 *
 * Regra (Gabriel, 18/11/2026): dado do Brasil so para grupo com Brasil. Com `COUNTRY_RLS_ENABLED=false` o banco
 * nao recorta (o app entra como dono, sem FORCE RLS), entao o recorte tem de estar na aplicacao. Aqui: le o
 * `country` do paciente e responde 404 (nao 403: nao confirma que o paciente existe) quando ele esta fora do
 * escopo do ator. O escopo vem de `resolveCountryScope` (um dono: `iam.effective_countries`); sem pais => 403
 * COUNTRY_SCOPE_REQUIRED, igual a lista/stats.
 *
 * Montado com `router.use` ANTES das rotas `:id`/`:patientId` e DEPOIS do `requireStaff` (precisa do uid no
 * contexto). Id que nao e UUID passa direto: o handler devolve o 400 de sempre e nenhum dado sai.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { resolveCountryScope, CountryScopeError } from '@modules/identity';
import { currentDbContext } from '@shared/database/requestDbSession';
import { reportError } from '@shared/logging';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requirePatientInCountryScope(getPool: () => Pool): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const id = req.params.id ?? req.params.patientId;
    if (!id || !UUID_RE.test(id)) return next();

    try {
      const db = getPool();
      const scope = await resolveCountryScope(db, currentDbContext()?.uid, undefined);
      const { rows } = await db.query<{ country: string }>('SELECT country FROM patients WHERE id = $1', [id]);
      // Inexistente: segue, o handler responde o 404 dele (mesma resposta do fora-de-escopo).
      if (rows.length === 0) return next();
      if (!(scope.countries as string[]).includes(String(rows[0].country).trim())) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      next();
    } catch (err) {
      if (err instanceof CountryScopeError) {
        res.status(err.status).json({ success: false, error: err.code, detail: err.message });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'patientCountryScopeGuard' });
      // Falha fechada: sem decidir o escopo, nenhum dado sai.
      res.status(500).json({ success: false, error: 'Failed to resolve country scope' });
    }
  };
}
