import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { cellsOfRequest } from '@modules/identity/permissions';
import { GetFunnelTableUseCase } from '../../application/GetFunnelTableUseCase';
import { FunnelBucket } from '../../domain/FunnelTableRow';
import { FUNNEL_COLUMNS } from '../../domain/kanbanColumn';

const VALID_BUCKETS = new Set<FunnelBucket>([
  'ALL', 'INVITED', 'POSTULATED', 'PRE_SELECTED', 'REJECTED', 'WITHDREW',
]);

/** As 8 colunas do Kanban, sem BLOQUEADO (D433: tentativa negada = REJECTED). */
const VALID_COLUMNS = new Set<string>(FUNNEL_COLUMNS);

/**
 * WJAFunnelTableController
 *
 * Audit-table endpoint for admin vacancy pages.
 * Complements WJAFunnelController (Kanban) — does NOT replace it.
 *
 * Renamed from EncuadreFunnelTableController in F7.a (migration 194).
 *
 * GET /api/admin/vacancies/:id/funnel-table
 *   ?bucket=ALL|INVITED|POSTULATED|PRE_SELECTED|REJECTED|WITHDREW  (default ALL)
 */
export class WJAFunnelTableController {
  private useCase: GetFunnelTableUseCase;

  constructor() {
    this.useCase = new GetFunnelTableUseCase();
  }

  async getEncuadreFunnelTable(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const bucketParam = (req.query.bucket as string | undefined) ?? 'ALL';

      if (!VALID_BUCKETS.has(bucketParam as FunnelBucket)) {
        res.status(400).json({
          success: false,
          error: `Invalid bucket "${bucketParam}". Valid values: ${[...VALID_BUCKETS].join(', ')}`,
        });
        return;
      }

      // ?columns=<ids CSV> — filtro por coluna do Kanban (DX-2.6). BLOQUEADO nunca é
      // válido aqui: a tentativa negada é filtrada por REJECTED (D433).
      const columns = (req.query.columns as string | undefined)?.split(',').filter(Boolean) ?? null;
      if (columns) {
        const invalida = columns.find((c) => !VALID_COLUMNS.has(c));
        if (invalida) {
          res.status(400).json({ success: false, error: `Invalid column "${invalida}"` });
          return;
        }
      }

      // F2/C3: as células do ator descem até a projeção. `cellsOfRequest`
      // devolve `null` quando o engine não decidiu — e `null` ≠ `[]`.
      const result = await this.useCase.execute(id, bucketParam as FunnelBucket, cellsOfRequest(req), columns);

      res.json({ success: true, data: result });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'WJAFunnelTableController:getEncuadreFunnelTable' });
      res.status(500).json({ success: false, error: e.message });
    }
  }
}
