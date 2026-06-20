/**
 * WorkerPhoneMergeTypes
 *
 * Tipos usados pelo WorkerPhoneMergeService e WorkerPhoneMergeOrchestrator.
 * Separados para manter cada arquivo dentro do limite de 400 linhas.
 */

// ─── Categoria de merge ────────────────────────────────────────────────────

/** Categorias alinhadas com a coluna worker_merge_audit.category */
export type MergeCategory = 'firebase' | 'most_complete' | 'ghost';

// ─── Worker dentro de um grupo de colisão ─────────────────────────────────

export interface WorkerInGroup {
  id: string;
  auth_uid: string;
  email: string;
  phone: string | null;
  phone_normalized: string | null;
  updated_at: Date;
  merged_into_id: string | null;
  /** Número de campos não-nulos no registro (usado por most_complete) */
  completeness_score: number;
  /** Número de documentos associados */
  document_count: number;
  /** Todos os campos não-nulos do worker (para COALESCE) */
  non_null_fields: string[];
  /** Campos de identidade legal (para checagem de divergência) */
  document_number_encrypted: string | null;
  data_sources: string[] | null;
}

// ─── Resultado por grupo (dry-run e execução real) ──────────────────────────

export interface MergeGroupPlan {
  phone_normalized: string;
  category: MergeCategory | 'conflict' | 'skip';
  worker_ids: string[];
  survivor_id: string | null;
  absorbed_ids: string[];
  /** Campos divergentes que requerem revisão humana */
  legal_field_exceptions: LegalFieldException[];
  /** Razão da decisão do sobrevivente */
  survivor_reason: string;
}

export interface LegalFieldException {
  field: string;
  survivor_value_hash: string | null;
  absorbed_value_hash: string | null;
  reason: string;
}

// ─── Ghost reconciliation ──────────────────────────────────────────────────

export interface GhostMatchPlan {
  ghost_id: string;
  real_id: string;
  phone_normalized: string;
  ghost_email: string;
  real_email: string;
}

export interface GhostOrphan {
  worker_id: string;
  email: string;
  phone: string | null;
  phone_normalized: string | null;
  reason: 'no_phone' | 'no_real_match';
}

// ─── Relatório de dry-run / execução ──────────────────────────────────────

export interface MergePlanReport {
  /** Data/hora da análise */
  analyzed_at: string;

  /** Totais */
  total_collision_groups: number;
  total_firebase_groups: number;
  total_most_complete_groups: number;
  total_conflict_groups: number;
  total_ghost_matches: number;
  total_ghost_orphans: number;

  /** Planos por grupo */
  group_plans: MergeGroupPlan[];

  /** Ghost matches planejados */
  ghost_matches: GhostMatchPlan[];

  /** Ghosts sem match (candidatos a desativação) */
  ghost_orphans: GhostOrphan[];

  /** Grupos conflitantes (>1 Firebase real) — revisão humana */
  conflict_groups: MergeGroupPlan[];

  /** Total de merges que SERIAM executados (excluindo conflitos) */
  total_merges_planned: number;

  /** Erros encontrados durante análise */
  analysis_errors: string[];
}

// ─── Resultado de execução real ────────────────────────────────────────────

export interface MergeExecutionResult {
  plan: MergePlanReport;
  merges_executed: number;
  merges_skipped: number;
  errors: MergeError[];
  execution_started_at: string;
  execution_finished_at: string;
}

export interface MergeError {
  phone_normalized: string;
  survivor_id: string | null;
  absorbed_id: string | null;
  error: string;
}

// ─── Tier de worker ────────────────────────────────────────────────────────

/**
 * Classifica um worker em três tiers para eleição do sobrevivente.
 *
 * TIER 1 — humano real:        auth_uid não-sintético E email sem sufixo @enlite.import
 * TIER 2 — claimed sem email:  auth_uid não-sintético MAS email com sufixo @enlite.import
 * TIER 3 — ghost/import:       auth_uid sintético (qualquer email)
 *
 * Sobrevivente = maior tier; desempate: selectMostComplete → updated_at.
 * CONFLICT = ≥2 TIER 1 no mesmo grupo (revisão humana obrigatória).
 */
export type WorkerTier = 1 | 2 | 3;

// ─── Constantes ────────────────────────────────────────────────────────────

/**
 * Prefixos de auth_uid que indicam worker SINTÉTICO (não-Firebase real).
 *
 * SSOT: src/modules/worker/application/InitWorkerUseCase.ts (função isImportedWorker, linha 22-29)
 *       + src/modules/matching/application/ProcessTalentumPrescreening.ts (prefixo talentum_).
 *
 * Prefixos abaixo devem ser mantidos em sincronia com a SSOT acima.
 * NÃO adicionar prefixos fictícios (IMPORT, DEDUP, CLICKUP, ANON) — causam falsos negativos.
 */
export const SYNTHETIC_AUTH_UID_PREFIXES = [
  'anacareimport_',
  'candidatoimport_',
  'pretalnimport_',
  'base1import_',
  'clickup_encuadre_',
  'talentum_',
] as const;

/**
 * Sufixo de email usado em workers importados/ghosts.
 * Worker com este sufixo e auth_uid não-sintético é TIER 2 (claimed sem email real).
 */
export const IMPORT_EMAIL_SUFFIX = '@enlite.import' as const;

/**
 * Campos legais que NUNCA são auto-sobrescritos quando divergentes.
 * Apenas COALESCE (preenchimento de null → valor) é seguro nesses campos.
 */
export const LEGAL_FIELDS = [
  'document_number_encrypted',
] as const;

export type LegalField = (typeof LEGAL_FIELDS)[number];

/**
 * Todos os campos de FK de worker_id que devem ser reparentados no merge.
 * Lista derivada de information_schema: todas as tabelas com FK para workers(id)
 * exceto workers.merged_into_id (auto-referência usada pelo merge em si).
 *
 * Verificado via:
 *   grep -rn "REFERENCES workers" migrations/ | grep -v "merged_into_id|merge_survivor"
 */
export const FK_TABLES_TO_REPARENT: ReadonlyArray<{
  table: string;
  /** Estratégia de reparent */
  strategy: 'update' | 'upsert_delete';
  /** Colunas que compõem a unique key (para ON CONFLICT em upsert) */
  unique_cols?: string[];
}> = [
  // Tabelas onde UPDATE simples é seguro (sem unique constraint em worker_id+X)
  { table: 'worker_service_areas',          strategy: 'update' },
  { table: 'worker_availability',           strategy: 'update' },
  { table: 'worker_quiz_responses',         strategy: 'update' },
  { table: 'worker_employment_history',     strategy: 'update' },
  { table: 'worker_locations',              strategy: 'update' },
  { table: 'worker_placement_audits',       strategy: 'update' },
  { table: 'worker_status_history',         strategy: 'update' },
  { table: 'worker_additional_documents',   strategy: 'update' },
  { table: 'worker_reminder_state',         strategy: 'update' },
  { table: 'worker_pending_profile_changes', strategy: 'update' },
  { table: 'worker_profile_changes_audit',  strategy: 'update' },
  { table: 'worker_tags',                   strategy: 'upsert_delete', unique_cols: ['worker_id', 'tag_id'] },
  // worker_documents e worker_payment_info: UNIQUE(worker_id) → upsert para não duplicar
  { table: 'worker_documents',              strategy: 'upsert_delete', unique_cols: ['worker_id'] },
  { table: 'worker_payment_info',           strategy: 'upsert_delete', unique_cols: ['worker_id'] },
  // messaging
  { table: 'messaging_outbox',              strategy: 'update' },
  { table: 'messaging_variable_tokens',     strategy: 'update' },
  { table: 'messaging_opt_out',             strategy: 'update' },
  { table: 'whatsapp_bulk_dispatch_logs',   strategy: 'update' },
  // prescreenings
  { table: 'talentum_prescreenings',        strategy: 'update' },
  // encuadres (SET NULL on delete; update pra manter vínculo)
  { table: 'encuadres',                     strategy: 'update' },
  // blacklist: unique(worker_id, reason)
  { table: 'blacklist',                     strategy: 'upsert_delete', unique_cols: ['worker_id', 'reason'] },
  // worker_job_applications: unique(worker_id, job_posting_id)
  { table: 'worker_job_applications',       strategy: 'upsert_delete', unique_cols: ['worker_id', 'job_posting_id'] },
] as const;
