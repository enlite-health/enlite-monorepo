/**
 * WorkerPhoneMergeReparent
 *
 * Gera as queries de reparent de FK worker_id para todas as tabelas filho.
 * Separado de WorkerPhoneMergeHelpers para manter cada arquivo ≤ 400 linhas.
 *
 * Estratégias:
 *   'update'       → UPDATE simples (sem unique constraint problemática)
 *   'upsert_delete' → Para tabelas com unique(worker_id) ou unique(worker_id, X):
 *                     deleta conflitos antes de reparentar, depois limpa o absorvido.
 *
 * Lista de tabelas derivada de:
 *   grep -rn "REFERENCES workers" migrations/ | grep -v merged_into_id
 */

import { FK_TABLES_TO_REPARENT } from './WorkerPhoneMergeTypes';

export interface ReparentQuery {
  sql: string;
  params: unknown[];
  description: string;
}

/**
 * Gera todas as queries de reparent em ordem de execução segura.
 *
 * Para tabelas N:1 com unique(worker_id, col):
 *   1. DELETE do absorvido os registros que o sobrevivente já tem (evita duplicate key)
 *   2. UPDATE worker_id = survivorId WHERE worker_id = absorbedId
 *
 * Para tabelas 1:1 com unique(worker_id):
 *   1. UPDATE worker_id = survivorId WHERE worker_id = absorbedId
 *        AND NOT EXISTS (survivor já tem linha) — move apenas se sobrevivente está vazio
 *   2. DELETE FROM tabela WHERE worker_id = absorbedId — limpa qualquer restante
 *
 * Para tabelas sem unique em worker_id:
 *   1. UPDATE simples
 */
export function buildReparentQueries(survivorId: string, absorbedId: string): ReparentQuery[] {
  const queries: ReparentQuery[] = [];

  for (const cfg of FK_TABLES_TO_REPARENT) {
    if (cfg.strategy === 'update') {
      queries.push({
        sql:  `UPDATE ${cfg.table} SET worker_id = $1 WHERE worker_id = $2`,
        params: [survivorId, absorbedId],
        description: `reparent:update:${cfg.table}`,
      });
      continue;
    }

    // strategy === 'upsert_delete'
    const isOneToOne =
      cfg.unique_cols?.length === 1 && cfg.unique_cols[0] === 'worker_id';

    if (isOneToOne) {
      // Tabela 1:1: move somente se o sobrevivente ainda não tem linha
      queries.push({
        sql: `UPDATE ${cfg.table}
              SET worker_id = $1
              WHERE worker_id = $2
                AND NOT EXISTS (
                  SELECT 1 FROM ${cfg.table} WHERE worker_id = $1
                )`,
        params: [survivorId, absorbedId],
        description: `reparent:1to1_move_if_empty:${cfg.table}`,
      });
      // Apaga qualquer linha remanescente do absorvido (coberta pelo sobrevivente)
      queries.push({
        sql:  `DELETE FROM ${cfg.table} WHERE worker_id = $1`,
        params: [absorbedId],
        description: `reparent:1to1_cleanup:${cfg.table}`,
      });
    } else {
      // Tabela N:1 com unique(worker_id, col): ex blacklist unique(worker_id, reason)
      // Passo 1: remove do absorvido as linhas que o sobrevivente já cobre
      const conflictCols = (cfg.unique_cols ?? []).filter(c => c !== 'worker_id');
      if (conflictCols.length > 0) {
        const joinCond = conflictCols.map(c => `a.${c} = s.${c}`).join(' AND ');
        queries.push({
          sql: `DELETE FROM ${cfg.table} a
                USING ${cfg.table} s
                WHERE a.worker_id = $1
                  AND s.worker_id = $2
                  AND ${joinCond}`,
          params: [absorbedId, survivorId],
          description: `reparent:Nto1_dedup_conflicts:${cfg.table}`,
        });
      }
      // Passo 2: reparent das linhas restantes do absorvido
      queries.push({
        sql:  `UPDATE ${cfg.table} SET worker_id = $1 WHERE worker_id = $2`,
        params: [survivorId, absorbedId],
        description: `reparent:Nto1_update:${cfg.table}`,
      });
    }
  }

  return queries;
}
