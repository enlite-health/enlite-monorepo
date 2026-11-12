import { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { currentDbContext } from '@shared/database/requestDbSession';
import { resolveCountryScope, CountryScopeError } from '@modules/identity';
import { EnquadreListRangeError, parseEnquadreListRange } from '../../domain/enquadreListQuery';
import type { EnquadreEventGlobalList } from '../../application/EnquadreEventGlobalList';

/**
 * EnquadreEventListController — lista GLOBAL de enquadres (spec 076), cross-vacante.
 *
 *   GET /enquadre-events   enquadre_event:read + vacancy:read (as duas; a rota declara)
 *
 * País resolvido NO SERVIDOR (`resolveCountryScope`, como o Gestão à Vista): `enquadre_events` não tem RLS, então o predicado de
 * país vai sempre ao SQL. Erro de domínio vira `{ success:false, code }` ESTÁVEL (a tela traduz pelo `code`, nunca ecoa mensagem).
 * O 500 é genérico e o `reportError` leva SÓ a origem: `q` e `host` podem carregar nome — nunca vão a log.
 */
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (v: string) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const day = z.string().regex(YMD).refine(isRealDay);
const STATUSES = ['open', 'closed', 'cancelled'] as const;

const listQuery = z
  .object({
    from: day.optional(),
    to: day.optional(),
    status: z
      .string()
      .max(40)
      .transform((v) => v.split(','))
      .pipe(z.array(z.enum(STATUSES)).min(1))
      .optional(),
    host: z.string().max(200).optional(),
    country: z.enum(['AR', 'BR', 'ALL']).optional(),
    q: z.string().max(50).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export class EnquadreEventListController {
  constructor(
    private readonly db: Pool,
    private readonly list: Pick<EnquadreEventGlobalList, 'execute'>,
  ) {}

  async listAll(req: Request, res: Response): Promise<void> {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid params', code: 'INVALID_PARAMS' });
      return;
    }
    const q = query.data;
    try {
      const range = parseEnquadreListRange(q.from, q.to);
      const scope = await resolveCountryScope(this.db, currentDbContext()?.uid, q.country);
      const data = await this.list.execute({
        countries: scope.countries,
        from: range?.from ?? null,
        to: range?.to ?? null,
        statuses: q.status ?? null,
        host: q.host && q.host !== '' ? q.host : null,
        q: q.q ?? null,
        limit: q.limit,
        offset: q.offset,
      });
      res.status(200).json({ success: true, data: { ...data, scope: { countries: scope.countries, requested: scope.requested } } });
    } catch (err: unknown) {
      if (err instanceof EnquadreListRangeError) {
        res.status(400).json({ success: false, error: 'Invalid range', code: err.code });
        return;
      }
      if (err instanceof CountryScopeError) {
        res.status(err.status).json({ success: false, error: err.code, code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'EnquadreEventListController:listAll' });
      res.status(500).json({ success: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
    }
  }
}
