/**
 * DedupTypes
 *
 * Tipos compartilhados entre os use cases e controllers do Centro de Duplicados.
 */

// ── Tier de worker (reexportado para uso nos use cases) ────────────────────

export type WorkerTier = 1 | 2 | 3;

// ── Conta dentro de um grupo ───────────────────────────────────────────────

export interface DedupWorkerAccount {
  id: string;
  email: string;
  tier: WorkerTier;
  status: string;
  created_at: string;
  updated_at: string;
  wja_count: number;
  docs_count: number;
  encuadres_count: number;
  login_real: boolean;
  /** auth_uid — nunca exibe valor; usado para tier classification */
  auth_uid_prefix: string;
  /** true = email termina em @enlite.import (worker importado, sem conta real) */
  is_imported: boolean;
}

// ── Grupo de duplicados ────────────────────────────────────────────────────

export interface DedupGroup {
  phone_normalized: string;
  accounts: DedupWorkerAccount[];
  survivor_suggested_id: string | null;
  survivor_reason: string;
}

// ── Preview de merge (detalhe do grupo) ────────────────────────────────────

export interface DedupMergePreview {
  phone_normalized: string;
  accounts: DedupWorkerAccountDetail[];
  reparent_preview: ReparentPreview;
  field_comparison: FieldComparison[];
}

export interface DedupWorkerAccountDetail extends DedupWorkerAccount {
  profession: string | null;
  country: string | null;
  /** Flag: campo encriptado (não exibir valor cru) */
  has_encrypted_pii: boolean;
}

export interface ReparentPreview {
  wja_total: number;
  docs_total: number;
  encuadres_total: number;
  other_fk_tables: string[];
}

export interface FieldComparison {
  field: string;
  survivor_has_value: boolean;
  absorbed_has_value: boolean;
  /** true = campo encriptado (PII) — valor não exibido */
  is_encrypted: boolean;
  conflict: boolean;
}

// ── Parâmetros de entrada dos use cases ────────────────────────────────────

export interface ExecuteMergeParams {
  survivorId: string;
  absorbedIds: string[];
  /** Choices de campo: chave=nome do campo, valor='survivor'|'absorbed:<id>' */
  fieldChoices?: Record<string, string>;
  /** auth_uid do admin que executou (para auditoria) */
  executedBy?: string;
}

export interface DismissGroupParams {
  phoneNormalized: string;
  reason?: string;
  dismissedBy?: string;
}

// ── Resultado de execução de merge (admin) ─────────────────────────────────

export interface AdminMergeResult {
  audit_ids: number[];
  survivor_id: string;
  absorbed_ids: string[];
}

// ── Grupo de importados duplicados por nome ────────────────────────────────

/**
 * Conta dentro de um grupo de dedup por nome (importados).
 * Extende DedupWorkerAccount com is_imported já presente.
 */
export type ImportedDedupWorkerAccount = DedupWorkerAccount;

/**
 * Grupo de workers com mesmo name_trgm_bidx (nome fuzzy idêntico),
 * onde ao menos 1 membro é @enlite.import e merged_into_id IS NULL.
 */
export interface ImportedDedupGroup {
  /** BYTEA[] serializado como hex string — chave opaca de agrupamento */
  name_trgm_bidx_key: string;
  accounts: ImportedDedupWorkerAccount[];
  match_type: 'name';
  confidence: 'name_fuzzy';
  survivor_suggested_id: string | null;
  survivor_reason: string;
  /** true = há ao menos 1 conta real (não-import) no grupo */
  has_real: boolean;
}

export interface ListImportedDedupGroupsParams {
  /** Se true, retorna só grupos com ao menos 1 conta real (não-import) */
  onlyWithReal?: boolean;
}

// ── Histórico de merges ────────────────────────────────────────────────────

export interface MergeHistoryEntry {
  audit_id: number;
  survivor_id: string;
  absorbed_id: string;
  phone_normalized: string;
  category: string;
  fields_filled: string[];
  exceptions: unknown[];
  created_at: string;
  can_undo: boolean;
}
