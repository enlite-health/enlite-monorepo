/**
 * WorkerStatusFlow — fluxo declarado de TODA escrita em workers.status (spec 093, DF-3).
 * Lista fechada; mesma grafia e ordem do CHECK de worker_status_history.flow (migration 591).
 * Dono da lista = o CHECK do banco; teste compara pg_get_constraintdef × este enum.
 * Sem valor "UNDECLARED": caller novo = valor novo aqui + no CHECK.
 */

export type WorkerStatusFlow =
  | 'WIZARD_PERSONAL_INFO'
  | 'WIZARD_AVAILABILITY'
  | 'WIZARD_SERVICE_AREA'
  | 'WIZARD_STEP'
  | 'WORKER_DOCUMENT_UPLOAD'
  | 'ADMIN_DOCUMENT_REVIEW'
  | 'PROFILE_FIELDS_EDIT'
  | 'ADMIN_STATUS_CHANGE'
  | 'WORKER_IMPORT'
  | 'PHONE_MERGE'
  | 'CLAIM_SHELL_ABSORB'
  | 'ADMIN_MERGE'
  | 'MERGE_UNDO'
  | 'ARCHIVE_REACTIVATION'
  | 'ACCOUNT_DEACTIVATION'
  | 'MIGRATION'
  | 'MANUAL_SCRIPT'
  | 'TEST_FIXTURE';

export const WORKER_STATUS_FLOWS: readonly WorkerStatusFlow[] = [
  'WIZARD_PERSONAL_INFO',
  'WIZARD_AVAILABILITY',
  'WIZARD_SERVICE_AREA',
  'WIZARD_STEP',
  'WORKER_DOCUMENT_UPLOAD',
  'ADMIN_DOCUMENT_REVIEW',
  'PROFILE_FIELDS_EDIT',
  'ADMIN_STATUS_CHANGE',
  'WORKER_IMPORT',
  'PHONE_MERGE',
  'CLAIM_SHELL_ABSORB',
  'ADMIN_MERGE',
  'MERGE_UNDO',
  'ARCHIVE_REACTIVATION',
  'ACCOUNT_DEACTIVATION',
  'MIGRATION',
  'MANUAL_SCRIPT',
  'TEST_FIXTURE',
] as const;
