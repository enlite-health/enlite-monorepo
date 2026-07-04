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
 * A WJA row persisted by the matchmaking algorithm (MatchmakingService.saveMatchResults:
 * source='system', stage='INVITED') that was never actually messaged
 * (messaged_at IS NULL) is a *match candidate*, not an invitation. Running a
 * match writes ALL top-N candidates as INVITED/system, so counting them in the
 * "Invitados" column inflates the metric (ClickUp 86ajb48v1 AC2:
 * "colocar todos está gerando uma métrica falsa"). Only a real send
 * (MessagingController sets messaged_at) turns a match candidate into an invite.
 *
 * @param stage      worker_job_applications.application_funnel_stage
 * @param source     worker_job_applications.source
 * @param messagedAt worker_job_applications.messaged_at (ISO string / Date / null)
 */
export function isMatchedNotInvited(
  stage: string | null,
  source: string | null,
  messagedAt: string | Date | null,
): boolean {
  return source === 'system' && stage === 'INVITED' && messagedAt == null;
}

/**
 * Display order of the Kanban columns, from least to most advanced.
 *
 * Used by the management dashboard to collapse a worker with N applications into
 * the SINGLE column that best describes where that person stands ("furthest
 * column reached"), so the consolidated view sums to the distinct-worker total.
 *
 * ⚠️ This is NOT `funnel_stage_precedence(text)` (migrations 185/190) and must not
 * be replaced by it. That function ranks REJECTED at 7, TIED with SELECTED —
 * correct for its purpose (the upsert guard "a stage never regresses": a fresh
 * invite must not overwrite a rejection), wrong for display: a worker REJECTED on
 * vacancy A and IN_PROGRESS on vacancy B is an active candidate, not a rejected
 * one. Here REJECTED ranks LAST: it only describes a person when nothing else does.
 *
 * BLOQUEADO is absent on purpose — blocked attempts have no WJA and are counted
 * from `worker_blocked_applications`, never collapsed into a worker's funnel column.
 */
const KANBAN_COLUMN_ADVANCEMENT: readonly KanbanColumn[] = [
  'REJECTED',
  'INVITED',
  'INICIADO',
  'PRE_SCREENING',
  'IN_PROGRESS',
  'COMPLETED',
  'CONFIRMED',
  'SELECTED',
];

/**
 * Rank of a column in the advancement order — higher = further along the funnel.
 * Throws on an unranked column so that adding a Kanban column without deciding
 * where it sits fails the build instead of silently vanishing from the dashboard.
 */
export function kanbanColumnRank(column: KanbanColumn): number {
  const rank = KANBAN_COLUMN_ADVANCEMENT.indexOf(column);
  if (rank === -1) {
    throw new Error(
      `kanbanColumnRank: column "${column}" has no declared advancement rank. ` +
        'Add it to KANBAN_COLUMN_ADVANCEMENT (kanbanColumn.ts) before using it in the dashboard.',
    );
  }
  return rank;
}

/** Columns a worker can occupy in the funnel, least → most advanced. */
export const FUNNEL_COLUMNS: readonly KanbanColumn[] = KANBAN_COLUMN_ADVANCEMENT;

/** Returns the most advanced of two columns (used to collapse a worker's N applications). */
export function mostAdvancedColumn(a: KanbanColumn, b: KanbanColumn): KanbanColumn {
  return kanbanColumnRank(a) >= kanbanColumnRank(b) ? a : b;
}

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
  if (stage === 'PRE_SCREENING') return 'PRE_SCREENING';
  // INVITED+manual = clicou em postularse manualmente → coluna INICIADO.
  if (stage === 'INVITED' && source === 'manual') return 'INICIADO';
  // INVITED (auto-invite), null, ou stage desconhecido → INVITED (fallback).
  return 'INVITED';
}
