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
 */
export type ApplicationFunnelStage =
  | 'INITIATED'      // iniciado na Talentum
  | 'IN_PROGRESS'    // em progresso
  | 'COMPLETED'      // concluiu o processo Talentum
  | 'QUALIFIED'      // aprovado pela Talentum
  | 'IN_DOUBT'       // em dúvida
  | 'CONFIRMED'      // worker confirmou slot de encuadre
  | 'SELECTED'       // selecionado no encuadre
  | 'REJECTED'       // rejeitado no encuadre (inclui auto-rejeição por NOT_QUALIFIED Talentum — migration 191)
  | 'PLACED';        // worker está atualmente atuando nessa vaga

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
