/**
 * dedupGroupBuilder
 *
 * Módulo compartilhado entre ListImportedDedupGroupsUseCase e
 * BuildManualDedupGroupUseCase.
 *
 * Exporta:
 *   - electSurvivor(members)  → {survivorId, survivorReason}
 *   - toImportedAccount(row)  → ImportedDedupWorkerAccount
 *
 * Extraído de ListImportedDedupGroupsUseCase (refactor sem mudança de comportamento).
 */

import { classifyWorkerTier, selectMostComplete } from '../../infrastructure/services/WorkerPhoneMergeHelpers';
import type { ImportedDedupWorkerAccount, WorkerTier } from './DedupTypes';
import {
  IMPORT_EMAIL_SUFFIX,
  SYNTHETIC_AUTH_UID_PREFIXES,
} from '../../infrastructure/services/WorkerPhoneMergeTypes';

// ── Tipos internos ─────────────────────────────────────────────────────────

/**
 * Shape mínimo de linha de banco necessário pelo builder.
 * Compatível tanto com RawWorkerRow de ListImportedDedupGroupsUseCase
 * quanto com o fetch de BuildManualDedupGroupUseCase.
 */
export interface BuilderWorkerRow {
  id: string;
  email: string;
  auth_uid: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  completeness_score: number;
  document_count: number;
  wja_count: number;
  encuadres_count: number;
  document_number_encrypted: string | null;
  data_sources: string[] | null;
  phone_normalized: string | null;
}

// ── Helpers puros ──────────────────────────────────────────────────────────

export function isImportedEmail(email: string): boolean {
  return email.toLowerCase().includes(IMPORT_EMAIL_SUFFIX);
}

export function isSyntheticUid(authUid: string | null | undefined): boolean {
  if (!authUid || authUid.trim() === '') return true;
  return SYNTHETIC_AUTH_UID_PREFIXES.some(prefix => authUid.startsWith(prefix));
}

export function extractPrefix(authUid: string | null | undefined): string {
  if (!authUid) return 'null';
  const match = SYNTHETIC_AUTH_UID_PREFIXES.find(p => authUid.startsWith(p));
  return match ?? 'real';
}

// ── Mapeador de conta ──────────────────────────────────────────────────────

/**
 * Mapeia uma linha do banco para ImportedDedupWorkerAccount.
 * Inclui phone_normalized como extensão (campo extra, compatível
 * com o shape que BuildManualDedupGroupUseCase expõe).
 */
export function toImportedAccount(
  row: BuilderWorkerRow,
): ImportedDedupWorkerAccount & { phone_normalized: string | null } {
  return {
    id: row.id,
    email: row.email,
    tier: classifyWorkerTier({ auth_uid: row.auth_uid ?? '', email: row.email }) as WorkerTier,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    wja_count: row.wja_count,
    docs_count: row.document_count,
    encuadres_count: row.encuadres_count,
    login_real: !isSyntheticUid(row.auth_uid) && !isImportedEmail(row.email),
    auth_uid_prefix: extractPrefix(row.auth_uid),
    is_imported: isImportedEmail(row.email),
    phone_normalized: row.phone_normalized,
  };
}

// ── Eleição do survivor ────────────────────────────────────────────────────

/**
 * Elege o survivor sugerido para um grupo de workers.
 *
 * Regras:
 *   - 1 conta real (não-import) → ela é survivor (reason: real_account_absorbs_imported)
 *   - >1 conta real             → conflito (survivor_id=null, reason: conflict_multiple_real_accounts)
 *   - 0 conta real              → mais completo entre importados (reason: most_complete_imported)
 */
export function electSurvivor(
  members: BuilderWorkerRow[],
): { survivorId: string | null; survivorReason: string } {
  const realMembers = members.filter(m => !isImportedEmail(m.email));
  const importedMembers = members.filter(m => isImportedEmail(m.email));

  if (realMembers.length === 1) {
    return {
      survivorId: realMembers[0].id,
      survivorReason: 'real_account_absorbs_imported',
    };
  }

  if (realMembers.length > 1) {
    return { survivorId: null, survivorReason: 'conflict_multiple_real_accounts' };
  }

  // 0 conta real → most_complete entre importados
  const best = selectMostComplete(
    importedMembers.map(m => ({
      id: m.id,
      auth_uid: m.auth_uid ?? '',
      email: m.email,
      phone: null,
      phone_normalized: m.phone_normalized,
      updated_at: m.updated_at,
      merged_into_id: null,
      completeness_score: m.completeness_score,
      document_count: m.document_count,
      non_null_fields: [],
      document_number_encrypted: m.document_number_encrypted,
      data_sources: m.data_sources,
    })),
  );

  return { survivorId: best.id, survivorReason: 'most_complete_imported' };
}
