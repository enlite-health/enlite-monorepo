/**
 * Single source of truth for the WJA → Kanban column mapping.
 *
 * The vacancy Kanban (WJAFunnelController.getEncuadreFunnel) and the worker-detail
 * "encuadre" tab (AdminWorkersDetailBuilder) must agree on which column a worker
 * occupies for a given vacancy. This function is that agreement — classify by
 * application_funnel_stage (+ source for the INVITED/manual split) in ONE place so
 * the two surfaces can never drift.
 *
 * Migration 230: INITIATED renamed to PRE_SCREENING; INICIADO added (INVITED+manual).
 * Feature BLOQUEADO (2026-07-03): blocked attempts (worker_blocked_applications) have
 * no funnel stage — they map to KANBAN_COLUMN_BLOCKED, handled by the caller, not here.
 */
export type KanbanColumn =
  | 'INVITED'
  | 'BLOQUEADO'
  | 'INICIADO'
  | 'PRE_SCREENING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CONFIRMED'
  | 'SELECTED'
  | 'REJECTED';

/** Column for a blocked postulation attempt (no WJA / no funnel stage). */
export const KANBAN_COLUMN_BLOCKED: KanbanColumn = 'BLOQUEADO';

/**
 * Derives the Kanban column for a WJA row from its funnel stage + source.
 * Mirrors the classification chain in WJAFunnelController.getEncuadreFunnel.
 *
 * @param stage  worker_job_applications.application_funnel_stage (nullable)
 * @param source worker_job_applications.source (nullable) — 'manual' means the worker
 *               clicked postularse (→ INICIADO), otherwise it's an auto-invite (→ INVITED)
 */
export function deriveKanbanColumn(stage: string | null, source: string | null): KanbanColumn {
  if (stage === 'SELECTED') return 'SELECTED';
  if (stage === 'REJECTED') return 'REJECTED';
  if (stage === 'CONFIRMED') return 'CONFIRMED';
  if (stage !== null && ['COMPLETED', 'QUALIFIED', 'IN_DOUBT'].includes(stage)) return 'COMPLETED';
  if (stage === 'IN_PROGRESS') return 'IN_PROGRESS';
  // INITIATED só ocorre transitoriamente em rolling deploy — mapeia p/ PRE_SCREENING.
  if (stage === 'PRE_SCREENING' || stage === 'INITIATED') return 'PRE_SCREENING';
  // INVITED+manual = clicou em postularse manualmente → coluna INICIADO.
  if (stage === 'INVITED' && source === 'manual') return 'INICIADO';
  // INVITED (auto-invite), null, ou stage desconhecido → INVITED (fallback).
  return 'INVITED';
}
