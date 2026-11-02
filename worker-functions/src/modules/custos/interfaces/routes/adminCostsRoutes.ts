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
 * Envelope do backend: 200 `{ success: true, data }`; erros `{ success: false, code }` (como PedidoIaController): 400 `invalid_month` · 429 `sync_rate_limited` + `retryAfterSeconds` · 502 `billing_query_failed` | `bytes_limit`, sem texto cru do BigQuery.
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
      res.status(200).json({ success: true, data: await useCase.execute(month) });
    } catch (err) {
      if (err instanceof InvalidMonthError) return void res.status(400).json({ success: false, code: 'invalid_month' });
      if (err instanceof SyncRateLimitedError) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
        return void res.status(429).json({ success: false, code: 'sync_rate_limited', retryAfterSeconds: err.retryAfterSeconds });
      }
      const code = err instanceof BillingReadError ? err.code : 'billing_query_failed';
      // Causa para diagnóstico: code/reason/name apenas, nunca `message` nem SQL.
      const reason = err instanceof BillingReadError ? err.reason : undefined;
      const name = err instanceof BillingReadError ? err.causeName : err instanceof Error ? err.name : undefined;
      logger.warn({ code, reason, name }, 'costs overview failed');
      res.status(502).json({ success: false, code });
    }
  });

  return router;
}
