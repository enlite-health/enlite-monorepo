/**
 * WorkerMergeUndoService
 *
 * Desfaz um merge a partir do seu ID de auditoria: restaura o absorvido ao
 * estado exato pré-merge (snapshot) e carimba QUEM desfez na auditoria.
 * Extraído de WorkerPhoneMergeService para manter o serviço ≤400 linhas.
 *
 * Idempotente: se já desfeito, retorna alreadyUndone=true sem regravar undo.
 */

import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logging';
import type { UndoAuditContext } from '../../application/dedup/DedupTypes';
import { restoreSnapshot } from './WorkerMergeSnapshotService';
import { recordUndoAudit } from './WorkerMergeAuditWriter';

const log = logger.child({ source: 'WorkerMergeUndoService' });

export async function undoMergeTx(
  pool: Pool,
  mergeAuditId: number | bigint,
  undoAudit?: UndoAuditContext,
): Promise<{ survivorId: string; absorbedId: string; alreadyUndone: boolean }> {
  const auditRes = await pool.query<{ survivor_id: string; absorbed_id: string }>(
    `SELECT survivor_id, absorbed_id FROM worker_merge_audit WHERE id = $1`,
    [mergeAuditId],
  );
  if (auditRes.rows.length === 0) {
    throw new Error(`worker_merge_audit id=${mergeAuditId} não encontrado`);
  }
  const { survivor_id: survivorId, absorbed_id: absorbedId } = auditRes.rows[0];

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await restoreSnapshot(client, { mergeAuditId, survivorId, absorbedId });

    // Carimba QUEM desfez — só quando houve reversão real (não em no-op idempotente).
    if (!result.alreadyUndone) {
      await recordUndoAudit(client, mergeAuditId, undoAudit ?? {});
    }

    await client.query('COMMIT');

    // AUDIT: log do undo (Cloud Logging — fora do alcance de quem mexe no DB).
    log.info({
      msg: 'merge_undone',
      mergeAuditId: String(mergeAuditId),
      survivorId,
      absorbedId,
      alreadyUndone: result.alreadyUndone,
      undone_by: undoAudit?.undoneBy ?? 'system',
      undone_by_email: undoAudit?.undoneByEmail ?? null,
      undo_ip_address: undoAudit?.ipAddress ?? null,
      undo_request_id: undoAudit?.requestId ?? null,
    });

    return { survivorId, absorbedId, alreadyUndone: result.alreadyUndone };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
