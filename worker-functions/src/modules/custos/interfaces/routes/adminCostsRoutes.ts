import { Router, Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_INTEGRATIONS_FAMILY } from '@modules/identity/permissions';
import { logger } from '@shared/logging';
import { InvalidMonthError } from '../../application/GetCostOverviewUseCase';
import { BillingReadError, SyncRateLimitedError, type CostOverview } from '../../domain/types';

export interface CostOverviewPort {
  execute(month?: string): Promise<CostOverview>;
}

/**
 * GET /api/admin/costs/overview?month=YYYY-MM — painel de custos (spec 082, contrato §9.2). Célula `platform_costs:read`
 * (Acesso Master only), família `admin.integrations` (a mesma de `pedidos_ia`: nenhuma família nova).
 * Ordem do array da rota: `staffOnly` -> `perm.require` -> handler; `perm.require` nunca em closure.
 * Erros: 400 mês inválido · 429 `{ retryAfterSeconds }` · 502 `{ code }` (`billing_query_failed` | `bytes_limit`), sem texto cru do BigQuery.
 */
export function createAdminCostsRoutes(
  useCase: CostOverviewPort,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

  router.get('/costs/overview', staffOnly, perm.require('platform_costs', 'read', { untilEnforced: 'admin' }), async (req: Request, res: Response) => {
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    try {
      res.status(200).json(await useCase.execute(month));
    } catch (err) {
      if (err instanceof InvalidMonthError) return void res.status(400).json({ code: 'invalid_month' });
      if (err instanceof SyncRateLimitedError) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
        return void res.status(429).json({ retryAfterSeconds: err.retryAfterSeconds });
      }
      const code = err instanceof BillingReadError ? err.code : 'billing_query_failed';
      logger.warn({ code }, 'costs overview failed');
      res.status(502).json({ code });
    }
  });

  return router;
}
