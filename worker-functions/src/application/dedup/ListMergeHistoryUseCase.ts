/**
 * ListMergeHistoryUseCase
 *
 * Lista merges executados (de worker_merge_audit) com flag can_undo.
 * can_undo = true quando existe snapshot e undone_at IS NULL.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import type { MergeHistoryEntry } from './DedupTypes';

const log = logger.child({ source: 'ListMergeHistoryUseCase' });

export class ListMergeHistoryUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(opts: { limit?: number; offset?: number } = {}): Promise<MergeHistoryEntry[]> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    log.info({ msg: 'list_merge_history_start', limit, offset });

    const res = await this.pool.query<{
      id: number;
      survivor_id: string;
      absorbed_id: string;
      phone_normalized: string;
      category: string;
      fields_filled: string[];
      exceptions: unknown[];
      created_at: Date;
      has_snapshot: boolean;
      undone_at: Date | null;
    }>(
      `SELECT
         a.id,
         a.survivor_id,
         a.absorbed_id,
         a.phone_normalized,
         a.category,
         a.fields_filled,
         a.exceptions,
         a.created_at,
         s.id IS NOT NULL                    AS has_snapshot,
         s.undone_at
       FROM worker_merge_audit a
       LEFT JOIN worker_merge_snapshots s
         ON s.merge_audit_id = a.id
        AND s.absorbed_worker_id = a.absorbed_id
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const entries: MergeHistoryEntry[] = res.rows.map(r => ({
      audit_id: Number(r.id),
      survivor_id: r.survivor_id,
      absorbed_id: r.absorbed_id,
      phone_normalized: r.phone_normalized,
      category: r.category,
      fields_filled: r.fields_filled ?? [],
      exceptions: r.exceptions ?? [],
      created_at: r.created_at.toISOString(),
      can_undo: r.has_snapshot && r.undone_at == null,
    }));

    log.info({ msg: 'list_merge_history_done', total: entries.length });

    return entries;
  }
}
