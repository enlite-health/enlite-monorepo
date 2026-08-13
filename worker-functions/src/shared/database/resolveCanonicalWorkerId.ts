/**
 * resolveCanonicalWorkerId
 *
 * Segue a corrente de merged_into_id até o worker VIVO (merged_into_id IS NULL).
 * Helper ÚNICO para todo caller que recebe um worker id possivelmente mergeado
 * (login por auth_uid, elegibilidade de postulação, etc.) — não duplicar.
 * Compartilhado com a change OpenSpec matching-merge-aware-eligibility.
 *
 * Retorna:
 *   - o id vivo (o próprio, se não mergeado; o fim da corrente, se mergeado)
 *   - null se o id não existe OU a corrente não resolve dentro de MAX_MERGE_DEPTH
 *     (ciclo/corrupção — não trava, loga e devolve null)
 */

import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logging';

// Lazy: suítes que mockam @shared/logging sem child não podem quebrar no import.
const log = () => logger.child({ source: 'resolveCanonicalWorkerId' });

export const MAX_MERGE_DEPTH = 10;

export async function resolveCanonicalWorkerId(
  db: Pool | PoolClient,
  workerId: string,
): Promise<string | null> {
  const res = await db.query<{ id: string; depth: number; merged_into_id: string | null }>(
    `WITH RECURSIVE chain AS (
       SELECT id, merged_into_id, 0 AS depth
       FROM workers WHERE id = $1::uuid
       UNION ALL
       SELECT w.id, w.merged_into_id, c.depth + 1
       FROM workers w
       JOIN chain c ON w.id = c.merged_into_id
       WHERE c.depth < $2
     )
     SELECT id, depth, merged_into_id FROM chain
     ORDER BY depth DESC LIMIT 1`,
    [workerId, MAX_MERGE_DEPTH],
  );

  if (res.rows.length === 0) return null; // id não existe

  const deepest = res.rows[0];
  if (deepest.merged_into_id != null) {
    // corrente não terminou em worker vivo dentro do limite (ciclo/corrupção)
    log().warn({
      msg: 'merge_chain_unresolved',
      workerId,
      depth: deepest.depth,
      maxDepth: MAX_MERGE_DEPTH,
    });
    return null;
  }

  if (deepest.depth > 0) {
    log().info({
      msg: 'resolved_via_merge',
      workerId,
      canonicalId: deepest.id,
      hops: deepest.depth,
    });
  }

  return deepest.id;
}
