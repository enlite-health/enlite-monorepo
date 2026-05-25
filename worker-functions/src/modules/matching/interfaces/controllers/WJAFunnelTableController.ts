import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { GetFunnelTableUseCase } from '../../application/GetFunnelTableUseCase';
import { FunnelBucket } from '../../domain/FunnelTableRow';

const VALID_BUCKETS = new Set<FunnelBucket>([
  'ALL', 'INVITED', 'POSTULATED', 'PRE_SELECTED', 'REJECTED', 'WITHDREW',
]);

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

      const result = await this.useCase.execute(id, bucketParam as FunnelBucket);

      res.json({ success: true, data: result });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'WJAFunnelTableController:getEncuadreFunnelTable' });
      res.status(500).json({ success: false, error: e.message });
    }
  }
}
