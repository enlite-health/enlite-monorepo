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
