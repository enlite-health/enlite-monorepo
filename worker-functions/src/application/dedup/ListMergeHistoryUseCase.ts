/**
 * ListMergeHistoryUseCase
 *
 * Lista merges executados (de worker_merge_audit) com flag can_undo.
 * can_undo = true quando existe snapshot e undone_at IS NULL.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import type { MergeHistoryEntry } from './DedupTypes';
import { loadWorkerDisplayNames } from './loadWorkerDisplayNames';

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
      executed_by: string | null;
      executed_by_email: string | null;
      source: string | null;
      confirmed_same_person: boolean | null;
      undone_by_email: string | null;
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
         a.executed_by,
         a.executed_by_email,
         a.source,
         a.confirmed_same_person,
         a.undone_by_email,
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

    // Nomes humanos decriptados (admin-only) pras duas contas de cada merge —
    // o operador precisa VER quem ficou e quem foi absorvido, nunca o UUID.
    const allIds = res.rows.flatMap(r => [r.survivor_id, r.absorbed_id]);
    const names = await loadWorkerDisplayNames(this.pool, allIds);

    const entries: MergeHistoryEntry[] = res.rows.map(r => ({
      audit_id: Number(r.id),
      survivor_id: r.survivor_id,
      absorbed_id: r.absorbed_id,
      survivor_name: names.get(r.survivor_id) ?? null,
      absorbed_name: names.get(r.absorbed_id) ?? null,
      phone_normalized: r.phone_normalized,
      category: r.category,
      fields_filled: r.fields_filled ?? [],
      exceptions: r.exceptions ?? [],
      created_at: r.created_at.toISOString(),
      can_undo: r.has_snapshot && r.undone_at == null,
      executed_by: r.executed_by ?? null,
      executed_by_email: r.executed_by_email ?? null,
      source: r.source ?? null,
      confirmed_same_person: r.confirmed_same_person ?? null,
      undone_by_email: r.undone_by_email ?? null,
    }));

    log.info({ msg: 'list_merge_history_done', total: entries.length });

    return entries;
  }
}
