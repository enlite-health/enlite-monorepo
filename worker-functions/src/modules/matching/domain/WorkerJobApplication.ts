export interface WorkerJobApplication {
  id: string;

  // Relationships
  workerId: string;
  jobPostingId: string;

  // Application data
  coverLetter?: string;

  // Match score (for future matching system)
  matchScore?: number;  // 0-100

  // Process tracking
  appliedAt: Date;
  reviewedAt?: Date;
  interviewScheduledAt?: Date;
  decisionAt?: Date;
  hiredAt?: Date;

  // Feedback
  rejectionReason?: string;
  internalNotes?: string;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Funnel stage for the Talentum process, per vacancy.
 * Replaces the old ApplicationStatus (systemic) + ApplicationFunnelStage (UI) split.
 * Single source of truth: application_funnel_stage column in worker_job_applications.
 *
 * Migration 230 (2026-06-26): PRE_SCREENING adicionado; INVITED adicionado (existia no banco
 * desde migration 131 mas estava ausente do tipo TypeScript). INITIATED removido do tipo.
 * Migration 264 (2026-07-04): INITIATED removido do CHECK do banco (Fase-2 completa).
 */
export type ApplicationFunnelStage =
  | 'INVITED'        // clicou em postularse (pré-Talentum); source='manual' → coluna "INICIADO" no kanban
  | 'PRE_SCREENING'  // entrou no formulário Talentum (antigo INITIATED — migration 230)
  | 'IN_PROGRESS'    // em progresso no prescreening Talentum
  | 'COMPLETED'      // concluiu o processo Talentum
  | 'QUALIFIED'      // aprovado pela Talentum
  | 'IN_DOUBT'       // em dúvida
  | 'CONFIRMED'      // worker confirmou slot de encuadre
  | 'SELECTED'       // selecionado no encuadre
  | 'REJECTED';      // rejeitado no encuadre (inclui auto-rejeição por NOT_QUALIFIED Talentum — migration 191)
  // 'PLACED' removido em F7.a (migration 194 — 0 linhas em prod, sync F6 morta)
  // 'INITIATED' removido do tipo em migration 230; removido do banco em migration 264

export interface CreateWorkerJobApplicationDTO {
  workerId: string;
  jobPostingId: string;
  coverLetter?: string;
}

export interface UpdateWorkerJobApplicationDTO {
  id: string;
  applicationFunnelStage?: ApplicationFunnelStage;
  matchScore?: number;
  rejectionReason?: string;
  internalNotes?: string;
}

export interface WithdrawApplicationDTO {
  id: string;
  workerId: string;
}
