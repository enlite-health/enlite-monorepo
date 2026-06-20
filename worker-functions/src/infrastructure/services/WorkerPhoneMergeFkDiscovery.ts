/**
 * WorkerPhoneMergeFkDiscovery
 *
 * Descobre em RUNTIME todas as colunas de FK que apontam para workers(id),
 * consultando information_schema do banco conectado.
 *
 * Por que dinâmico e não hardcoded:
 *   A lista hardcoded (FK_TABLES_TO_REPARENT) foi derivada via grep nas migrations
 *   do branch, mas produção tem drift de schema — tabelas inexistentes no branch
 *   causavam "relation does not exist" na transação, zerando todos os merges.
 *   A descoberta dinâmica garante resiliência a drift em qualquer direção.
 *
 * Decisão — múltiplas FKs por tabela:
 *   Se uma tabela tiver worker_id + reviewed_by_worker_id apontando para workers(id),
 *   ambas as colunas são reparentadas. Isso evita FK órfã mesmo em colunas secundárias.
 *   O campo `fk_column` em FkTableInfo permite identificar qual coluna foi reparentada.
 *
 * Exceção — workers.merged_into_id:
 *   A auto-referência workers.merged_into_id é excluída explicitamente, pois é o
 *   mecanismo do merge em si (seria um loop: reparentar o campo que controla o merge).
 *
 * Estratégias de reparent:
 *   'update'        → UPDATE simples (sem unique constraint envolvendo a coluna FK)
 *   'upsert_delete' → Para tabelas com unique constraint que inclui a coluna FK:
 *                     deleta conflitos no absorvido e reparenta as linhas restantes.
 *
 * Descoberta de unique constraints:
 *   Para cada (table, fk_column), busca constraints UNIQUE e PRIMARY KEY que
 *   incluam essa coluna. Se existir, usa a estratégia upsert_delete e retorna
 *   as colunas que compõem o constraint (para gerar o DELETE de conflitos correto).
 */

import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logging';

const log = logger.child({ source: 'WorkerPhoneMergeFkDiscovery' });

// ─── Tipos públicos ────────────────────────────────────────────────────────

export type ReparentStrategy = 'update' | 'upsert_delete';

export interface FkTableInfo {
  /** Nome da tabela filha */
  table: string;
  /** Nome da coluna que referencia workers(id) */
  fk_column: string;
  /** Estratégia de reparent baseada na presença de unique constraint */
  strategy: ReparentStrategy;
  /**
   * Colunas que compõem o unique/PK constraint que inclui fk_column.
   * Preenchido apenas quando strategy === 'upsert_delete'.
   * Ex: ['worker_id', 'job_posting_id'] para worker_job_applications.
   */
  unique_cols: string[];
}

// ─── Query de descoberta de FKs ────────────────────────────────────────────

/**
 * Query SQL que retorna todas as (table, column) com FK para workers(id),
 * excluindo a auto-referência workers.merged_into_id.
 *
 * Usa information_schema para compatibilidade com Cloud SQL (Postgres 14+).
 * A query cruza:
 *   - table_constraints (tipo FOREIGN KEY)
 *   - key_column_usage  (coluna local)
 *   - constraint_column_usage (tabela/coluna referenciada)
 */
const FK_DISCOVERY_SQL = `
  SELECT
    kcu.table_name   AS fk_table,
    kcu.column_name  AS fk_column
  FROM information_schema.table_constraints       tc
  JOIN information_schema.key_column_usage        kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.table_schema    = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.table_schema    = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND ccu.table_name      = 'workers'
    AND ccu.column_name     = 'id'
    AND NOT (kcu.table_name = 'workers' AND kcu.column_name = 'merged_into_id')
  ORDER BY kcu.table_name, kcu.column_name
`;

// ─── Query de descoberta de unique constraints ─────────────────────────────

/**
 * Retorna as colunas de todas as constraints UNIQUE e PRIMARY KEY da tabela
 * que incluem a coluna FK informada.
 *
 * Se houver múltiplos constraints (ex: PK e UNIQUE sobrepostos), retorna o
 * que tem o menor número de colunas (mais restritivo = mais provável de conflitar).
 */
const UNIQUE_CONSTRAINT_SQL = `
  SELECT
    tc.constraint_name,
    json_agg(kcu2.column_name ORDER BY kcu2.ordinal_position) AS cols
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu2
    ON kcu2.constraint_name = tc.constraint_name
   AND kcu2.table_schema    = tc.table_schema
   AND kcu2.table_name      = tc.table_name
  WHERE tc.table_name      = $1
    AND tc.table_schema    = 'public'
    AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    AND EXISTS (
      SELECT 1 FROM information_schema.key_column_usage kcu3
       WHERE kcu3.constraint_name = tc.constraint_name
         AND kcu3.table_schema    = tc.table_schema
         AND kcu3.column_name     = $2
    )
  GROUP BY tc.constraint_name
  ORDER BY json_array_length(json_agg(kcu2.column_name)) ASC
  LIMIT 1
`;

// ─── Função principal ──────────────────────────────────────────────────────

/**
 * Descobre dinamicamente todas as FKs para workers(id) no banco conectado.
 *
 * Aceita Pool ou PoolClient (para rodar dentro de transação se necessário).
 * O caller típico passa um Pool (fora de transação).
 *
 * Loga:
 *   - Tabelas/colunas descobertas
 *   - Estratégia atribuída (update vs upsert_delete)
 *   - WARN se tabela do mapa legado não existir no banco (informativo)
 */
export async function discoverWorkerFkTables(
  db: Pool | PoolClient,
  opts: {
    /** Lista de tabelas conhecidas do mapa legado — usada apenas para WARN de drift */
    knownTables?: ReadonlyArray<string>;
  } = {},
): Promise<FkTableInfo[]> {
  // 1. Descobre todas as (table, fk_column) → workers(id)
  const fkResult = await db.query<{ fk_table: string; fk_column: string }>(
    FK_DISCOVERY_SQL,
  );

  if (fkResult.rows.length === 0) {
    log.warn({ msg: 'fk_discovery_empty', note: 'Nenhuma FK encontrada apontando para workers(id)' });
    return [];
  }

  // 2. Para cada par (table, fk_column), descobre a estratégia
  const tableInfos: FkTableInfo[] = [];

  for (const row of fkResult.rows) {
    const { fk_table, fk_column } = row;

    const uniqueResult = await db.query<{ cols: string[] }>(
      UNIQUE_CONSTRAINT_SQL,
      [fk_table, fk_column],
    );

    const hasUniqueConstraint = uniqueResult.rows.length > 0;
    const uniqueCols = hasUniqueConstraint ? uniqueResult.rows[0].cols : [];

    tableInfos.push({
      table:       fk_table,
      fk_column,
      strategy:    hasUniqueConstraint ? 'upsert_delete' : 'update',
      unique_cols: uniqueCols,
    });

    log.info({
      msg:       'fk_discovered',
      table:     fk_table,
      fk_column,
      strategy:  hasUniqueConstraint ? 'upsert_delete' : 'update',
      unique_cols: uniqueCols,
    });
  }

  // 3. WARN sobre tabelas do mapa legado que não existem no banco
  if (opts.knownTables && opts.knownTables.length > 0) {
    const foundTables = new Set(tableInfos.map(t => t.table));
    for (const known of opts.knownTables) {
      if (!foundTables.has(known)) {
        log.warn({
          msg:   'known_table_not_in_db',
          table: known,
          note:  'Tabela do mapa legado não existe neste banco (drift de schema). Ignorada com segurança.',
        });
      }
    }
  }

  log.info({
    msg:           'fk_discovery_complete',
    total_tables:  tableInfos.length,
    upsert_delete: tableInfos.filter(t => t.strategy === 'upsert_delete').length,
    update:        tableInfos.filter(t => t.strategy === 'update').length,
    tables:        tableInfos.map(t => `${t.table}.${t.fk_column}`),
  });

  return tableInfos;
}
