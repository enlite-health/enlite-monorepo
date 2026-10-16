/** Tipos e tabela de contagem da importação do Tactiq (extraídos de `AdmissionImportService`, spec 052 T-36a, sem mudar nada). */

export type ImportOutcome =
  | 'done'
  | 'already_done'
  | 'waiting'
  | 'rejected'
  | 'ambiguous'
  | 'expired'
  | 'blocked'
  | 'wrong_account'
  | 'vault_failed'
  | 'summary_failed'
  | 'transient'
  | 'too_early'
  | 'not_eligible'
  | 'skipped_test' | 'skipped_locked' | 'not_ready';

export interface ImportSummary {
  candidates: number;
  done: number;
  alreadyDone: number;
  waiting: number;
  rejected: number;
  ambiguous: number;
  expired: number;
  blocked: number;
  wrongAccount: number;
  failed: number;
  transient: number;
  skipped: number;
  errors: number;
}

export const emptySummary = (): ImportSummary => ({
  candidates: 0, done: 0, alreadyDone: 0, waiting: 0, rejected: 0, ambiguous: 0, expired: 0, blocked: 0, wrongAccount: 0,
  failed: 0, transient: 0, skipped: 0, errors: 0,
});

export const SUMMARY_KEY: Record<ImportOutcome, keyof ImportSummary> = {
  done: 'done', already_done: 'alreadyDone', waiting: 'waiting', rejected: 'rejected', ambiguous: 'ambiguous', expired: 'expired',
  blocked: 'blocked', wrong_account: 'wrongAccount', vault_failed: 'failed', summary_failed: 'failed', transient: 'transient',
  too_early: 'skipped', not_eligible: 'skipped', skipped_test: 'skipped', skipped_locked: 'skipped', not_ready: 'skipped',
};
