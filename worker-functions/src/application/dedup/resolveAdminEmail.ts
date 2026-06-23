/**
 * resolveAdminEmail
 *
 * Resolve o email do admin a partir do uid (Firebase) via tabela `users`.
 * Usado pela auditoria de merge/undo pra registrar QUEM executou de forma
 * legível (denormalizado no momento da ação).
 *
 * Gracioso: qualquer falha/ausência vira null — auditoria nunca derruba o merge.
 */

import type { Pool, PoolClient } from 'pg';
import { reportError } from '@shared/logging';

export async function resolveAdminEmail(
  db: Pool | PoolClient,
  uid: string | undefined | null,
): Promise<string | null> {
  if (!uid) return null;
  try {
    const res = await db.query<{ email: string | null }>(
      `SELECT email FROM users WHERE firebase_uid = $1 LIMIT 1`,
      [uid],
    );
    return res.rows[0]?.email ?? null;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: 'resolveAdminEmail', uid });
    return null;
  }
}
