import { KanbanColumn } from './kanbanColumn';

/**
 * A single vacancy a worker is engaged with, from the worker's point of view.
 *
 * Unifies the two funnel sources so the worker-detail "encuadre" tab shows the SAME
 * reality as the vacancy Kanban:
 *  - worker_job_applications (WJA) — real funnel entries, enriched with encuadre data
 *  - worker_blocked_applications  — blocked postulation attempts (isBlocked=true, BLOQUEADO)
 *
 * `kanbanStage` is the exact Kanban column the worker occupies for this vacancy
 * (see domain/kanbanColumn.ts), so the tab and the board never disagree.
 */
export interface WorkerEngagement {
  /** Stable row id: wja.id for funnel rows, worker_blocked_applications.id for blocked. */
  id: string;
  jobPostingId: string | null;
  caseNumber: number | null;
  vacancyNumber: number | null;
  patientName: string | null;
  /** job_postings.status (vacancy lifecycle), not the funnel column. */
  vacancyStatus: string | null;
  /** The Kanban column this worker is in for this vacancy. */
  kanbanStage: KanbanColumn;

  // Encuadre enrichment — present for WJA rows that have an encuadre, null for blocked.
  resultado: string | null;
  interviewDate: string | null;
  interviewTime: string | null;
  recruiterName: string | null;
  coordinatorName: string | null;
  rejectionReason: string | null;
  rejectionReasonCategory: string | null;
  attended: boolean | null;

  // Blocked-only fields (isBlocked=true).
  isBlocked: boolean;
  blockedReason: string | null;
  missingFields: string[];
  attemptCount: number | null;

  createdAt: string;
}
