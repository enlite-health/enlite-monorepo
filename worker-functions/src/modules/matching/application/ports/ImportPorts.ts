import type { PoolClient } from 'pg';
import type { SkippedTestStage } from '../../domain/admissionRealm';
import type { Ex } from './PostCallPorts';
import type { AdmissionSummaryInput } from './AdmissionImportPorts';

/**
 * Portos da importação do Tactiq (spec 052, Fase 3, T-34a): a lógica é UMA só (`AdmissionImportService`); muda a FONTE (a fila, a
 * leitura e o estado do registro) e o DESTINO (nome do objeto no cofre, rótulo e gravação do resumo, nomes de log e de trava).
 *
 *  - admissão: `AdmissionImportRepository` (fonte, conformidade estrutural conferida pelo compilador) e `AdmissionImportDestination`
 *    (embrulha `StoreAdmissionSummaryDocument`, que grava nos documentos do PACIENTE);
 *  - enquadre: fonte e destino próprios sobre `enquadre_events`, SEM `JOIN` em paciente (rodada 2 da Fase 3).
 */

/** O registro que a importação lê. `admission_code` carrega o código do sujeito (`ADM-` na admissão, `ENC-` no enquadre). */
export interface ImportSubject {
  id: string;
  country: string;
  host_email: string;
  admission_code: string | null;
  slot_start: Date;
  status: string;
  conference_ended_at: Date | null;
  import_status: string | null;
  import_attempts: number;
  patient_is_test: boolean;
  rehearsal_until: Date | null;
}

export type ImportState = 'waiting' | 'done' | 'rejected' | 'ambiguous' | 'expired' | 'blocked';

export interface ImportSource<S extends ImportSubject = ImportSubject> {
  listDueIds(now: Date, limit?: number, ex?: Ex): Promise<string[]>;
  find(id: string, ex?: Ex): Promise<S | null>;
  /**
   * `reason` (só com `blocked`): o motivo que o enquadre grava em `blocked_reason`; `transcript` (só com `done`): nome do objeto e sha256 no cofre.
   * A admissão ignora os dois (o motivo vai só à trilha).
   */
  setState(id: string, state: ImportState, ex: Ex, opts?: { countAttempt?: boolean; reason?: string; transcript?: { objectName: string; sha256: string } }): Promise<void>;
  hasEvent(subjectId: string, kind: string, ex?: Ex): Promise<boolean>;
  hasSkippedTest(subjectId: string, stage: SkippedTestStage, ex?: Ex): Promise<boolean>;
  hasBlockedReason(subjectId: string, reason: string, ex?: Ex): Promise<boolean>;
  countModelSummaryFailures(subjectId: string, ex?: Ex): Promise<number>;
}

export type SummaryStoreResult = { outcome: 'stored'; documentId: string; sizeBytes: number; sha256: string } | { outcome: 'duplicate' };

/** O PDF já está no bucket (fora de transação); falta a linha. `commit` grava na transação de quem chama; `discard` apaga o objeto. */
export interface PreparedSummary {
  commit(client: PoolClient): Promise<SummaryStoreResult>;
  discard(): Promise<void>;
}

export interface ImportNaming {
  /** Prefixo dos logs (`admission` | `enquadre`): as métricas do terraform filtram por ele. */
  prefix: string;
  /** Chave do id do sujeito nos logs. */
  idKey: string;
  /** Prefixo da trava advisory por sujeito (`admission_import` | `enquadre_import`): execuções sobrepostas não processam o mesmo. */
  lockNamespace: string;
}
export const ADMISSION_IMPORT_NAMING: ImportNaming = { prefix: 'admission', idKey: 'appointmentId', lockNamespace: 'admission_import' };

export interface ImportDestination<S extends ImportSubject = ImportSubject> {
  readonly naming: ImportNaming;
  /** Chave do objeto da transcrição no cofre (só criação). */
  vaultObjectName(subject: S, sha256: string): string;
  /** Título do PDF do resumo. */
  summaryLabel(subject: S): string;
  /** Sobe o PDF (sem transação) e devolve a gravação da linha do documento. `promptVersion` = versão do prompt que gerou o resumo. */
  prepareSummary(subject: S, pdf: Buffer, label: string, promptVersion: string): Promise<PreparedSummary>;
  /** Entrada EXTRA do resumo (o enquadre manda a lista de convocados). Ausente = nada além de transcrição, código e data. */
  summaryInput?(subject: S): Promise<Pick<AdmissionSummaryInput, 'convocados'>>;
}
