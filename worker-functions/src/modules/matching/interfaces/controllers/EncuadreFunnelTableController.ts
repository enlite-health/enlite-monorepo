import { Request, Response } from 'express';
import { GetFunnelTableUseCase } from '../../application/GetFunnelTableUseCase';
import { FunnelBucket } from '../../domain/FunnelTableRow';

const VALID_BUCKETS = new Set<FunnelBucket>([
  'ALL', 'INVITED', 'POSTULATED', 'PRE_SELECTED', 'REJECTED', 'WITHDREW',
]);

/**
 * EncuadreFunnelTableController
 *
 * Audit-table endpoint for admin vacancy pages.
 * Complements EncuadreFunnelController (Kanban) — does NOT replace it.
 *
 * GET /api/admin/vacancies/:id/funnel-table
 *   ?bucket=ALL|INVITED|POSTULATED|PRE_SELECTED|REJECTED|WITHDREW  (default ALL)
 */
export class EncuadreFunnelTableController {
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
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[EncuadreFunnelTableController] funnel-table error:', message);
      res.status(500).json({ success: false, error: message });
    }
  }
}
