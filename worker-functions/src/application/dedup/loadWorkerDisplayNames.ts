/**
 * loadWorkerDisplayNames
 *
 * Dado um conjunto de worker ids, devolve um nome humano EXIBÍVEL por id —
 * decriptando first_name/last_name via KMS (uso autorizado: chamado só de
 * endpoints admin-only, mesma PII visível na ficha do prestador).
 *
 * Fallbacks (nunca devolve UUID/ciphertext pro operador):
 *   - sem nome + email importado (@enlite.import) → "(importado)"
 *   - sem nome, conta real                         → "(sin nombre)"
 *
 * Decrypt é gracioso: erro num registro vira fallback, não derruba a lista.
 */

import type { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { IMPORT_EMAIL_SUFFIX } from '../../infrastructure/services/WorkerPhoneMergeTypes';

export const IMPORTED_NAME_FALLBACK = '(importado)';
export const NO_NAME_FALLBACK = '(sin nombre)';

interface WorkerNameRow {
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  email: string | null;
}

async function decryptOrNull(
  encryptionService: KMSEncryptionService,
  raw: string | null,
  field: string,
  workerId: string,
): Promise<string | null> {
  if (raw == null || raw === '') return null;
  try {
    const plaintext = await encryptionService.decrypt(raw);
    return plaintext === '' ? null : plaintext.trim();
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: 'loadWorkerDisplayNames:decrypt', field, workerId });
    return null;
  }
}

export async function loadWorkerDisplayNames(
  pool: Pool,
  ids: string[],
  encryptionService: KMSEncryptionService = new KMSEncryptionService(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;

  const res = await pool.query<WorkerNameRow>(
    `SELECT id, first_name_encrypted, last_name_encrypted, email
       FROM workers
      WHERE id = ANY($1::uuid[])`,
    [unique],
  );

  for (const row of res.rows) {
    const first = await decryptOrNull(encryptionService, row.first_name_encrypted, 'first_name', row.id);
    const last = await decryptOrNull(encryptionService, row.last_name_encrypted, 'last_name', row.id);
    const full = [first, last].filter(Boolean).join(' ').trim();

    if (full) {
      out.set(row.id, full);
    } else {
      const isImported = String(row.email ?? '').toLowerCase().includes(IMPORT_EMAIL_SUFFIX);
      out.set(row.id, isImported ? IMPORTED_NAME_FALLBACK : NO_NAME_FALLBACK);
    }
  }

  return out;
}
