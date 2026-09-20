/**
 * src/modules/identity/permissions/infrastructure/PgPermissionCatalogRepository.ts
 *
 * O catálogo é DERIVADO do código (design 1b): quem manda é a declaração na
 * rota, o banco é o espelho. Este repositório é o espelho — leitura direta de
 * `iam.permissions` e escrita pelas funções da mig 281 (contexto de sistema +
 * ACL `app_system`), nunca INSERT direto.
 *
 * O `sync` roda numa transação só: ou o catálogo inteiro reflete esta versão do
 * código, ou nada muda. Meio-catálogo é pior que catálogo velho — a tela de
 * grupo mostraria células que a próxima instância não reconhece.
 */

import type { Pool } from 'pg';
import type {
  CatalogSyncResult,
  DeclaredCell,
  PermissionCatalogRepository,
} from '../application/ports';
import { categoryFor, cellKey, type PermissionCell } from '../domain/PermissionCell';
import { readRows, withSystemWrite } from './dbAccess';
import { logger } from '@shared/logging';

/**
 * Células que o banco NUNCA descontinua pelo sync (410, anti-lockout): sem elas todo
 * gestor perde o painel de uma vez. Ausência na varredura é sintoma — vai para o log.
 */
export const PROTECTED_CELLS = ['permission_management:read', 'permission_management:write'] as const;

const SYSTEM_LABEL = 'boot:permission-catalog-sync';

interface CellRow {
  resource: string;
  action: string;
  category: string | null;
  description: string | null;
  owner_service: string | null;
  deprecated_at: Date | null;
}

export class PgPermissionCatalogRepository implements PermissionCatalogRepository {
  constructor(
    private readonly pool: Pool,
    private readonly systemPool: Pool,
  ) {}

  async list(options?: { includeDeprecated?: boolean }): Promise<PermissionCell[]> {
    const result = await readRows(() =>
      this.pool.query<CellRow>(
        `SELECT resource, action, category, description, owner_service, deprecated_at
           FROM iam.permissions
          WHERE ($1::boolean OR deprecated_at IS NULL)
          ORDER BY category, resource, action`,
        [options?.includeDeprecated === true],
      ),
    );
    return result.rows.map((row) => ({
      resource: row.resource,
      action: row.action,
      category: row.category ?? categoryFor(row.resource),
      description: row.description,
      ownerService: row.owner_service ?? 'worker-functions',
      deprecatedAt: row.deprecated_at,
    }));
  }

  async idsByCellKey(cellKeys: string[]): Promise<Map<string, string>> {
    if (cellKeys.length === 0) return new Map();
    const result = await readRows(() =>
      this.pool.query<{ id: string; key: string }>(
        `SELECT id, resource || ':' || action AS key
           FROM iam.permissions
          WHERE resource || ':' || action = ANY($1)
            AND deprecated_at IS NULL`,
        [cellKeys],
      ),
    );
    return new Map(result.rows.map((row) => [row.key, row.id]));
  }

  /**
   * Upsert do declarado + descontinuação do que sumiu, na mesma transação.
   *
   * A lista vazia é recusada pela função 281 (descontinuaria o catálogo inteiro,
   * e célula descontinuada some de `iam.effective_permissions` — todo staff
   * perderia todo acesso). O use case também barra antes de chegar aqui: duas
   * travas porque o custo do falso-negativo é o painel inteiro.
   */
  async sync(cells: DeclaredCell[], ownerService: string): Promise<CatalogSyncResult> {
    const liveKeys = cells.map((cell) => cellKey(cell.resource, cell.action));
    return withSystemWrite(this.systemPool, SYSTEM_LABEL, async (client) => {
      let inserted = 0;
      let revived = 0;
      for (const cell of cells) {
        const result = await client.query<{ outcome: string }>(
          `SELECT iam.sync_permission_cell($1, $2, $3, $4, $5) AS outcome`,
          [cell.resource, cell.action, cell.description ?? null, categoryFor(cell.resource), ownerService],
        );
        const outcome = result.rows[0]?.outcome;
        if (outcome === 'inserted') inserted += 1;
        if (outcome === 'revived') revived += 1;
      }
      for (const protegida of PROTECTED_CELLS) {
        if (!liveKeys.includes(protegida)) {
          logger.warn(
            { cell: protegida, ownerService },
            '[perm] célula protegida ausente da varredura — o banco a mantém (anti-lockout, 410); conferir o perímetro de rotas',
          );
        }
      }
      const gone = await client.query<{ n: number }>(
        `SELECT iam.deprecate_missing_permission_cells($1, $2::text[]) AS n`,
        [ownerService, liveKeys],
      );
      // D338: o Acesso Master (id fixo, migration 436) recebe TODA célula ativa a cada
      // sync — nunca outro grupo (C10/D285 continuam intactas para eles). Roda por último,
      // na MESMA transação: ou o catálogo inteiro (upsert + descontinuação + Master) reflete
      // esta versão, ou nada muda.
      const masterGrant = await client.query<{ n: number }>(
        `SELECT iam.grant_active_permissions_to_master() AS n`,
      );
      // B-1 (mig 451, decisão Gabriel 19/09/2026): as 5 contas fixas do Master reconciliam
      // no MESMO boot — conta criada depois da migration entra sem ação humana. Mesmo molde
      // do masterGrant acima (mesma transação, nunca remove, nunca toca outro grupo).
      const fixedAccountsGrant = await client.query<{ n: number }>(
        `SELECT iam.grant_master_fixed_accounts() AS n`,
      );
      return {
        inserted,
        revived,
        deprecated: gone.rows[0]?.n ?? 0,
        total: cells.length,
        masterGranted: masterGrant.rows[0]?.n ?? 0,
        fixedAccountsGranted: fixedAccountsGrant.rows[0]?.n ?? 0,
      };
    });
  }
}
