/**
 * WorkerPhoneMergeReparent
 *
 * Gera as queries de reparent de FK worker_id para todas as tabelas filho.
 * Separado de WorkerPhoneMergeHelpers para manter cada arquivo ≤ 400 linhas.
 *
 * Estratégias:
 *   'update'        → UPDATE simples (sem unique constraint problemática)
 *   'upsert_delete' → Para tabelas com unique(fk_column) ou unique(fk_column, X):
 *                     deleta conflitos antes de reparentar, depois limpa o absorvido.
 *
 * A lista de tabelas é descoberta dinamicamente por WorkerPhoneMergeFkDiscovery
 * (information_schema do banco conectado). Não há lista hardcoded neste arquivo.
 *
 * Multi-FK por tabela:
 *   Se uma tabela tiver múltiplas colunas apontando para workers(id) (ex:
 *   worker_id + reviewed_by_worker_id), cada coluna gera seu próprio conjunto de
 *   queries independentemente. Isso garante que não sobre FK órfã em nenhuma coluna.
 */

import type { FkTableInfo } from './WorkerPhoneMergeFkDiscovery';

export interface ReparentQuery {
  sql: string;
  params: unknown[];
  description: string;
}

/**
 * Gera todas as queries de reparent em ordem de execução segura,
 * com base na lista de FKs descobertas dinamicamente.
 *
 * Para tabelas N:1 com unique(fk_column, col):
 *   1. DELETE do absorvido os registros que o sobrevivente já tem (evita duplicate key)
 *   2. UPDATE fk_column = survivorId WHERE fk_column = absorbedId
 *
 * Para tabelas 1:1 com unique(fk_column) apenas:
 *   1. UPDATE fk_column = survivorId WHERE fk_column = absorbedId
 *        AND NOT EXISTS (survivor já tem linha) — move apenas se sobrevivente está vazio
 *   2. DELETE FROM tabela WHERE fk_column = absorbedId — limpa qualquer restante
 *
 * Para tabelas sem unique em fk_column:
 *   1. UPDATE simples
 */
export function buildReparentQueries(
  survivorId: string,
  absorbedId: string,
  discoveredFks: FkTableInfo[],
): ReparentQuery[] {
  const queries: ReparentQuery[] = [];

  for (const cfg of discoveredFks) {
    const col = cfg.fk_column;

    if (cfg.strategy === 'update') {
      queries.push({
        sql:         `UPDATE ${cfg.table} SET ${col} = $1 WHERE ${col} = $2`,
        params:      [survivorId, absorbedId],
        description: `reparent:update:${cfg.table}:${col}`,
      });
      continue;
    }

    // strategy === 'upsert_delete'
    const isOneToOne = cfg.unique_cols.length === 1 && cfg.unique_cols[0] === col;

    if (isOneToOne) {
      // Tabela 1:1: move somente se o sobrevivente ainda não tem linha
      queries.push({
        sql: `UPDATE ${cfg.table}
              SET ${col} = $1
              WHERE ${col} = $2
                AND NOT EXISTS (
                  SELECT 1 FROM ${cfg.table} WHERE ${col} = $1
                )`,
        params:      [survivorId, absorbedId],
        description: `reparent:1to1_move_if_empty:${cfg.table}:${col}`,
      });
      // Apaga qualquer linha remanescente do absorvido (coberta pelo sobrevivente)
      queries.push({
        sql:         `DELETE FROM ${cfg.table} WHERE ${col} = $1`,
        params:      [absorbedId],
        description: `reparent:1to1_cleanup:${cfg.table}:${col}`,
      });
    } else {
      // Tabela N:1 com unique(fk_column, col): ex blacklist unique(worker_id, reason)
      // Passo 1: remove do absorvido as linhas que o sobrevivente já cobre
      const conflictCols = cfg.unique_cols.filter(c => c !== col);
      if (conflictCols.length > 0) {
        const joinCond = conflictCols.map(c => `a.${c} = s.${c}`).join(' AND ');
        queries.push({
          sql: `DELETE FROM ${cfg.table} a
                USING ${cfg.table} s
                WHERE a.${col} = $1
                  AND s.${col} = $2
                  AND ${joinCond}`,
          params:      [absorbedId, survivorId],
          description: `reparent:Nto1_dedup_conflicts:${cfg.table}:${col}`,
        });
      }
      // Passo 2: reparent das linhas restantes do absorvido
      queries.push({
        sql:         `UPDATE ${cfg.table} SET ${col} = $1 WHERE ${col} = $2`,
        params:      [survivorId, absorbedId],
        description: `reparent:Nto1_update:${cfg.table}:${col}`,
      });
    }
  }

  return queries;
}
