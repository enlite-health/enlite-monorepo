/**
 * WorkerMergeSnapshotService
 *
 * Captura snapshot completo do worker absorvido ANTES de qualquer mutação,
 * persiste em worker_merge_snapshots, e restaura (undo) atomicamente.
 *
 * Por que snapshot é necessário:
 *   O reparent com estratégia upsert_delete DELETA linhas do absorvido que
 *   colidem com o sobrevivente (ex.: worker_documents 1:1). Sem snapshot,
 *   essas linhas se perdem para sempre. O snapshot é a ÚNICA fonte de verdade
 *   para restaurar o estado exato pré-merge.
 *
 * Estrutura do payload JSONB:
 *   {
 *     worker_row: { ...todas as colunas de workers... },
 *     fk_rows:   { "<table>": [ ...linhas WHERE fk_column = absorbedId... ] }
 *   }
 *
 * Idempotência do undo:
 *   Se undone_at IS NOT NULL, o undo já foi executado — retorna sem fazer nada.
 */

import type { PoolClient } from 'pg';
import { logger, reportError } from '@shared/logging';
import type { FkTableInfo } from './WorkerPhoneMergeFkDiscovery';

const log = logger.child({ source: 'WorkerMergeSnapshotService' });

// ── Tipos públicos ─────────────────────────────────────────────────────────

export interface MergeSnapshotPayload {
  worker_row: Record<string, unknown>;
  fk_rows: Record<string, Record<string, unknown>[]>;
}

// ── Captura ────────────────────────────────────────────────────────────────

/**
 * Captura o estado completo do absorvido dentro de uma transação já aberta.
 * Persiste em worker_merge_snapshots e retorna o ID do snapshot.
 *
 * DEVE ser chamado ANTES de qualquer UPDATE/DELETE na transação de merge.
 */
export async function captureSnapshot(
  client: PoolClient,
  params: {
    mergeAuditId: bigint | number;
    absorbedId: string;
    discoveredFks: FkTableInfo[];
  },
): Promise<string> {
  const { mergeAuditId, absorbedId, discoveredFks } = params;

  // 1. Captura a linha completa do worker absorvido
  const workerRes = await client.query<Record<string, unknown>>(
    `SELECT * FROM workers WHERE id = $1::uuid`,
    [absorbedId],
  );
  const workerRow = workerRes.rows[0] ?? {};

  // 2. Captura todas as linhas FK do absorvido por tabela
  const fkRows: Record<string, Record<string, unknown>[]> = {};

  for (const fk of discoveredFks) {
    try {
      const fkRes = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${fk.table} WHERE ${fk.fk_column} = $1::uuid`,
        [absorbedId],
      );
      if (fkRes.rows.length > 0) {
        fkRows[`${fk.table}:${fk.fk_column}`] = fkRes.rows;
      }
    } catch (err) {
      // Tabela pode não existir (drift de schema) — não interrompe o snapshot
      const e = err instanceof Error ? err : new Error(String(err));
      log.warn({
        msg: 'snapshot_fk_table_skip',
        table: fk.table,
        fk_column: fk.fk_column,
        reason: e.message,
      });
    }
  }

  const payload: MergeSnapshotPayload = { worker_row: workerRow, fk_rows: fkRows };

  // 3. Persiste o snapshot
  const snapshotRes = await client.query<{ id: string }>(
    `INSERT INTO worker_merge_snapshots
       (merge_audit_id, absorbed_worker_id, payload)
     VALUES ($1, $2::uuid, $3::jsonb)
     RETURNING id`,
    [mergeAuditId, absorbedId, JSON.stringify(payload)],
  );

  const snapshotId = snapshotRes.rows[0].id;

  log.info({
    msg: 'snapshot_captured',
    snapshotId,
    absorbedId,
    tables_captured: Object.keys(fkRows).length,
    fk_rows_total: Object.values(fkRows).reduce((s, rows) => s + rows.length, 0),
  });

  return snapshotId;
}

// ── Restauração (undo) ─────────────────────────────────────────────────────

/**
 * Restaura o estado do absorvido a partir do snapshot, dentro de uma transação.
 *
 * Ordem de operações:
 *   1. Verifica idempotência: se undone_at IS NOT NULL, retorna sem fazer nada.
 *   2. Limpa merged_into_id do absorvido (reativa o worker).
 *   3. Restaura a linha de workers para o estado exato do snapshot.
 *   4. Para cada tabela FK no snapshot:
 *      - Remove linhas que foram reparentadas (worker_id = survivorId) SE vieram do absorvido
 *      - Re-insere as linhas originais do absorvido (com worker_id = absorbedId)
 *   5. Marca undone_at = NOW() no snapshot.
 */
export async function restoreSnapshot(
  client: PoolClient,
  params: {
    mergeAuditId: bigint | number;
    survivorId: string;
    absorbedId: string;
  },
): Promise<{ alreadyUndone: boolean }> {
  const { mergeAuditId, survivorId, absorbedId } = params;

  // 1. Busca o snapshot e verifica idempotência
  const snapRes = await client.query<{
    id: string;
    payload: MergeSnapshotPayload;
    undone_at: Date | null;
  }>(
    `SELECT id, payload, undone_at
     FROM worker_merge_snapshots
     WHERE merge_audit_id = $1
       AND absorbed_worker_id = $2::uuid`,
    [mergeAuditId, absorbedId],
  );

  if (snapRes.rows.length === 0) {
    throw new Error(
      `Snapshot não encontrado para mergeAuditId=${mergeAuditId} absorbedId=${absorbedId}`,
    );
  }

  const snap = snapRes.rows[0];

  if (snap.undone_at != null) {
    log.info({ msg: 'undo_already_done', mergeAuditId, absorbedId, undone_at: snap.undone_at });
    return { alreadyUndone: true };
  }

  const payload = snap.payload as MergeSnapshotPayload;

  // 2. Reativa o absorvido: limpa merged_into_id
  await client.query(
    `UPDATE workers SET merged_into_id = NULL WHERE id = $1::uuid`,
    [absorbedId],
  );

  // 3. Restaura a linha completa de workers para o estado do snapshot
  await restoreWorkerRow(client, absorbedId, payload.worker_row);

  // 4. Restaura linhas FK
  for (const [tableKey, rows] of Object.entries(payload.fk_rows)) {
    const [tableName, fkColumn] = tableKey.split(':');
    if (!tableName || !fkColumn) continue;

    await restoreFkRows(client, {
      tableName,
      fkColumn,
      survivorId,
      absorbedId,
      rows,
    });
  }

  // 5. Marca snapshot como desfeito
  await client.query(
    `UPDATE worker_merge_snapshots SET undone_at = NOW() WHERE id = $1::uuid`,
    [snap.id],
  );

  log.info({
    msg: 'snapshot_restored',
    snapshotId: snap.id,
    absorbedId,
    survivorId,
    tables_restored: Object.keys(payload.fk_rows).length,
  });

  return { alreadyUndone: false };
}

// ── Helpers privados ───────────────────────────────────────────────────────

/**
 * Restaura a linha de workers via UPDATE SET com os valores do snapshot.
 * Não usa INSERT (o worker ainda existe com merged_into_id populado).
 */
async function restoreWorkerRow(
  client: PoolClient,
  absorbedId: string,
  workerRow: Record<string, unknown>,
): Promise<void> {
  // Exclui colunas geradas/imutáveis que não podem ser escritas diretamente
  const SKIP_COLS = new Set(['id', 'phone_normalized', 'created_at']);

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [col, val] of Object.entries(workerRow)) {
    if (SKIP_COLS.has(col)) continue;
    setClauses.push(`${col} = $${idx}`);
    values.push(val);
    idx++;
  }

  if (setClauses.length === 0) return;

  values.push(absorbedId);
  await client.query(
    `UPDATE workers SET ${setClauses.join(', ')} WHERE id = $${idx}::uuid`,
    values,
  );
}

/**
 * Restaura linhas FK de uma tabela:
 *   - Remove linhas do survivorId que vieram do reparent das linhas do absorvido
 *     (identificadas pelos valores das outras colunas iguais ao snapshot)
 *   - Re-insere as linhas originais do absorvido
 *
 * Para tabelas com strategy upsert_delete, o survivor pode ter a linha
 * (reparentada) OU a linha original (sobrevivente). O undo remove as reparentadas
 * e re-insere as do absorvido. Se o survivor tinha a linha original, ela fica.
 */
async function restoreFkRows(
  client: PoolClient,
  params: {
    tableName: string;
    fkColumn: string;
    survivorId: string;
    absorbedId: string;
    rows: Record<string, unknown>[];
  },
): Promise<void> {
  const { tableName, fkColumn, survivorId, absorbedId, rows } = params;

  if (rows.length === 0) return;

  // Descobre colunas disponíveis na tabela para INSERT seguro
  let availableCols: string[];
  try {
    const colRes = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = 'public'
       ORDER BY ordinal_position`,
      [tableName],
    );
    availableCols = colRes.rows.map(r => r.column_name);
  } catch {
    log.warn({ msg: 'restore_fk_skip_no_table', table: tableName });
    return;
  }

  for (const row of rows) {
    // Para cada linha original, tenta remover do survivor (se foi reparentada).
    // Prefere usar o PK (coluna "id") quando disponível — evita falhas de comparação
    // de timestamps (precisão microsegundo vs. milissegundo na serialização JSON).
    // Fallback: usa todas as colunas exceto fkColumn quando não há "id".
    const hasId = availableCols.includes('id') && row['id'] != null;
    const matchClauses: string[] = [];
    const matchVals: unknown[] = [survivorId];

    if (hasId) {
      matchClauses.push(`id = $2`);
      matchVals.push(row['id']);
    } else {
      const otherCols = Object.keys(row).filter(c => c !== fkColumn && availableCols.includes(c));
      otherCols.forEach((c, i) => {
        matchClauses.push(`${c} = $${i + 2}`);
        matchVals.push(row[c]);
      });
    }

    if (matchClauses.length > 0) {
      try {
        await client.query(
          `DELETE FROM ${tableName}
           WHERE ${fkColumn} = $1::uuid
             AND ${matchClauses.join(' AND ')}`,
          matchVals,
        );
      } catch {
        // Ignora se a linha não existir mais
      }
    }

    // Re-insere a linha original do absorvido
    const insertCols = Object.keys(row).filter(c => availableCols.includes(c));
    const insertVals = insertCols.map(c => row[c]);
    const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');

    try {
      await client.query(
        `INSERT INTO ${tableName} (${insertCols.join(', ')})
         VALUES (${placeholders})
         ON CONFLICT DO NOTHING`,
        insertVals,
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, {
        source: 'WorkerMergeSnapshotService:restoreFkRows',
        table: tableName,
        absorbedId,
      });
    }
  }
}
