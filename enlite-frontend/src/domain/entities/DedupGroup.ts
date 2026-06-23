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

/**
 * Classificação NUMÉRICA do backend para eleger o sobrevivente:
 * 1 = conta real, 2 = importada, 3 = fantasma/sintética.
 * NÃO é exibida pro operador (o card mostra `status` humano).
 * `string` mantido por compat com fixtures legados.
 */
export type WorkerTier = 1 | 2 | 3 | string;

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
  /** Decrypted human name, when the endpoint provides it (admin-only). Card prefers it over email. */
  name?: string | null;
  /** Normalized phone, when available — shown to the operator instead of jargon emails. */
  phone_normalized?: string | null;
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

// ── Manual merge types (Onda 5 — merge manual) ────────────────────────────────

/**
 * One candidate returned by GET /api/admin/dedup/candidates?q=<texto>
 */
export interface CandidateItem {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  login_real: boolean;
  is_imported: boolean;
}

/**
 * Account within a manual-group result. Extends ImportedDedupAccount with
 * the name and phone_normalized fields decrypted by the admin endpoint.
 */
export interface ManualGroupAccount extends ImportedDedupAccount {
  name: string;
  phone_normalized: string | null;
}

/**
 * Response of POST /api/admin/dedup/manual-group
 * Same shape as ImportedDedupGroup but accounts include name + phone_normalized.
 * field_comparisons mirrors the phone-group detail shape — same type, same semantics.
 */
export interface ManualGroupResult {
  accounts: ManualGroupAccount[];
  survivor_suggested_id: string | null;
  survivor_reason: SurvivorReason;
  /** Field-level comparison for the advanced chooser section (same shape as DedupGroupDetail). */
  field_comparisons: DedupFieldComparison[];
}
