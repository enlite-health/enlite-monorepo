/**
 * adminIntegrationsRoutes — /api/admin/integrations/*
 *
 * Monta as rotas de integração administrativa. Todas requerem admin.
 * Chamado em src/index.ts: app.use('/api/admin', createAdminIntegrationsRoutes(authMiddleware))
 */

import { Router, Request, Response } from 'express';
import { AnaCareBackfillController } from '../controllers/AnaCareBackfillController';
import { LancarPrestacaoAxonicoController } from '../controllers/LancarPrestacaoAxonicoController';
import { LancarPrestacaoAxonicoUseCase } from '../../application/LancarPrestacaoAxonicoUseCase';
import { AxonicoApiClient } from '../../infrastructure/AxonicoApiClient';
import { AxonicoLancamentoRepository } from '../../infrastructure/AxonicoLancamentoRepository';
import { PatientReadRepository } from '../../infrastructure/PatientReadRepository';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';

/**
 * ── Família `admin.integrations` (task 3.5-A4) ──────────────────────────────
 * Uma rota, uma célula: **`integration:execute`** (D116). É célula NOVA, fora do
 * seed da 206 — nasce quando o A7 ligar `PERMISSION_CATALOG_SYNC_ENABLED`.
 * `execute` e não `write`: o backfill não grava aqui, ele DISPARA sincronização
 * contra um sistema de terceiro (Ana Care), e `execute` é ação sensível (D-P4),
 * então o ALLOW também vai para a trilha.
 */
import { ADMIN_INTEGRATIONS_FAMILY } from '@modules/identity/permissions';
export { ADMIN_INTEGRATIONS_FAMILY };

export function createAdminIntegrationsRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const backfillController = new AnaCareBackfillController();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

  // ── Lançamento de prestação no Axonico (F4, `integracao-axonico`) ─────────
  // `AxonicoApiClient.create()` é MEMOIZADO (não recriado por request): a mesma instância cacheia
  // a sessão/token internamente, evitando um `POST /api/login` a cada chamada. `IAxonicoApiClient`
  // é `AxonicoApiClient.create()` — env quando presente (test/local), Secret Manager em produção
  // (mesmo padrão de `AnaCareClient.create()`).
  let axonicoClientPromise: ReturnType<typeof AxonicoApiClient.create> | null = null;
  const lancarPrestacaoController = new LancarPrestacaoAxonicoController(async () => {
    axonicoClientPromise ??= AxonicoApiClient.create();
    const axonicoApiClient = await axonicoClientPromise;
    return new LancarPrestacaoAxonicoUseCase(
      new PatientReadRepository(),
      axonicoApiClient,
      new AxonicoLancamentoRepository(),
    );
  });

  /**
   * POST /api/admin/integrations/anacare/backfill
   *
   * Corpo JSON (tudo opcional):
   *   { dryRun?: boolean, limit?: number }
   *
   * dryRun padrão = true (não faz rede, só conta elegíveis).
   * Para sincronizar de verdade: { "dryRun": false }.
   *
   * Requer admin.
   */
  router.post(
    '/integrations/anacare/backfill',
    authMiddleware.requireStaff(),
    perm.require('integration', 'execute', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => backfillController.handle(req, res),
  );

  /**
   * POST /api/admin/integrations/axonico/comprobante
   *
   * Corpo JSON: { patientId, serviceType, serviceDate: 'YYYY-MM-DD', hours }
   *
   * Lança UMA prestação de AT no Axonico (`PUT /api/comprobante`, via `IAxonicoApiClient`). Cada
   * chamada bem-sucedida GERA FATURAMENTO real no Axonico — não existe sandbox. Mesma célula
   * `integration:execute` do backfill acima (D116): ação sensível, sempre trilhada.
   */
  router.post(
    '/integrations/axonico/comprobante',
    authMiddleware.requireStaff(),
    perm.require('integration', 'execute', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => lancarPrestacaoController.handle(req, res),
  );

  /**
   * POST /api/admin/integrations/axonico/comprobante/lote
   *
   * Corpo JSON: { itens: [{ patientId, serviceType, serviceDate, hours }, ...] } (1 a 500 itens)
   *
   * Lança um LOTE — chama o caminho unitário em laço, item a item, com try/catch por item: falha
   * de um item NÃO aborta os seguintes (mesmo desenho de `BackfillWorkerMirrorUseCase.execute`).
   */
  router.post(
    '/integrations/axonico/comprobante/lote',
    authMiddleware.requireStaff(),
    perm.require('integration', 'execute', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => lancarPrestacaoController.handleLote(req, res),
  );

  return router;
}
