/**
 * Sincroniza o CATÁLOGO com o que o código declara (design 1b): as células
 * carimbadas nas rotas viram linhas em `iam.permissions`; o que sumiu do código
 * é marcado `deprecated_at` (nunca apagado — grupos antigos apontam para lá).
 *
 * DUAS TRAVAS contra o desastre silencioso, porque célula descontinuada some de
 * `iam.effective_permissions` e o custo do erro é "todo mundo perde tudo":
 *   1. varredura vazia NÃO sincroniza (aqui);
 *   2. `iam.deprecate_missing_permission_cells` recusa lista vazia (mig 281).
 * A varredura vem vazia sempre que o scanner roda antes das rotas serem
 * montadas — um erro de ORDEM de boot, que é fácil de cometer e impossível de
 * perceber sem isto.
 *
 * Nunca derruba o boot: catálogo velho serve; boot caído não.
 */

import { logger } from '@shared/logging';
import type { CatalogSyncResult, DeclaredCell, PermissionCatalogRepository } from './ports';

export const CATALOG_OWNER_SERVICE = 'worker-functions';

export class SyncPermissionCatalogUseCase {
  constructor(
    private readonly catalog: PermissionCatalogRepository,
    private readonly ownerService: string = CATALOG_OWNER_SERVICE,
  ) {}

  async execute(cells: DeclaredCell[]): Promise<CatalogSyncResult | null> {
    if (cells.length === 0) {
      logger.error(
        '[perm] varredura de rotas não encontrou NENHUMA célula declarada — sync do catálogo abortado (fail-closed)',
      );
      return null;
    }
    try {
      const result = await this.catalog.sync(cells, this.ownerService);
      logger.info({ ...result }, '[perm] catálogo de permissões sincronizado com as declarações do código');
      return result;
    } catch (err) {
      logger.error({ err }, '[perm] falha ao sincronizar o catálogo — o catálogo anterior segue valendo');
      return null;
    }
  }
}
