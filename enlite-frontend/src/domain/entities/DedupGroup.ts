/**
 * Domain types for the Deduplication Center (Centro de Duplicados).
 *
 * Endpoints:
 *   GET  /api/admin/dedup/groups
 *   GET  /api/admin/dedup/groups/:phoneNormalized
 *   POST /api/admin/dedup/merge
 *   POST /api/admin/dedup/dismiss
 */

// ── Account within a duplicate group ──────────────────────────────────────────

export type WorkerTier = 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'PRE_REGISTER' | string;

export interface DedupAccount {
  id: string;
  email: string | null;
  tier: WorkerTier;
  status: string;
  created_at: string;
  updated_at: string;
  wja_count: number;
  docs_count: number;
  encuadres_count: number;
  /** True when the worker has shown real login activity. */
  login_real: boolean;
}

// ── Group list item ────────────────────────────────────────────────────────────

export interface DedupGroupSummary {
  phone_normalized: string;
  accounts: DedupAccount[];
  /** Backend-suggested survivor account id. */
  survivor_suggested: string;
}

// ── Field-level comparison ─────────────────────────────────────────────────────

export interface DedupFieldComparison {
  field: string;
  /** Values per account id. Null when encrypted. */
  values: Record<string, string | null>;
  /** True when this field is PII-encrypted — values are not exposed. */
  is_encrypted: boolean;
  /** True when at least two accounts have different non-null values. */
  has_conflict: boolean;
}

export interface DedupReparentPreview {
  entity: string;
  count: number;
}

export interface DedupGroupDetail {
  phone_normalized: string;
  accounts: DedupAccount[];
  survivor_suggested: string;
  field_comparisons: DedupFieldComparison[];
  reparent_preview: DedupReparentPreview[];
}

// ── API request/response types ─────────────────────────────────────────────────

export interface MergeRequest {
  survivorId: string;
  absorbedIds: string[];
  fieldChoices?: Record<string, string>;
}

export interface MergeResult {
  survivorId: string;
  absorbedIds: string[];
  mergedAt: string;
}

export interface DismissRequest {
  phoneNormalized: string;
  reason?: string;
}

export interface DismissResult {
  phoneNormalized: string;
  dismissedAt: string;
}

// ── Imported group types (Onda 4b) ────────────────────────────────────────────

/**
 * Account within an imported-group (same shape as DedupAccount but with the
 * extra is_imported flag returned by the name-dedup endpoint).
 */
export interface ImportedDedupAccount extends DedupAccount {
  is_imported: boolean;
}

/**
 * Reason returned by GET /api/admin/dedup/imported-groups for the suggested
 * survivor selection.
 */
export type SurvivorReason =
  | 'real_account_absorbs_imported'
  | 'conflict_multiple_real_accounts'
  | 'most_complete';

/**
 * One group of accounts detected as duplicates by NAME (not phone).
 * Returned by GET /api/admin/dedup/imported-groups.
 */
export interface ImportedDedupGroup {
  accounts: ImportedDedupAccount[];
  survivor_suggested_id: string;
  survivor_reason: SurvivorReason;
  /** True when at least one account in the group is NOT imported (real account). */
  has_real: boolean;
}

// ── Merge history (Onda 3) ─────────────────────────────────────────────────────

export interface MergeHistoryItem {
  audit_id: number;
  survivor_id: string;
  absorbed_id: string;
  /** Nome humano da conta que ficou (decriptado no backend, admin-only). */
  survivor_name: string | null;
  /** Nome humano da conta absorvida (decriptado no backend, admin-only). */
  absorbed_name: string | null;
  phone_normalized: string;
  category: string;
  created_at: string;
  can_undo: boolean;
}

export interface UndoResult {
  auditId: string;
  restoredAt: string;
}
