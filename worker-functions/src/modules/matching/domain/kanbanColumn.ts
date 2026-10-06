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
 * no funnel stage — they map to KANBAN_COLUMN_BLOCKED (= INICIADO, D474; a dispensada
 * vai a REJECTED), via kanbanColumnForBlocked, handled by the caller, not here.
 */
export type KanbanColumn =
  | 'COMPATIBLE'
  | 'INVITED'
  | 'BLOQUEADO'
  | 'INICIADO'
  | 'PRE_SCREENING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CONFIRMED'
  | 'SELECTED'
  | 'QUICK_RESPONSE_TEAM'
  | 'REJECTED';

/**
 * Column for a blocked postulation attempt NOT dismissed — Iniciados com a tag BLOQUEADO
 * (D474, que revoga em parte a D433 item 5: o clique em Postularse leva a Iniciados, barrado ou não).
 */
export const KANBAN_COLUMN_BLOCKED: KanbanColumn = 'INICIADO';

/**
 * Column of a blocked attempt: INICIADO while active; REJECTED once the operator dismissed it
 * ("Rechazar", `dismissed_at` preenchido). Fonte única — Kanban, contagens, tabela e ficha do worker.
 */
export function kanbanColumnForBlocked(isDismissed: boolean): KanbanColumn {
  return isDismissed ? 'REJECTED' : KANBAN_COLUMN_BLOCKED;
}

/**
 * WJA "pré-Iniciado" (D474/M6): o worker ainda NÃO clicou em Postularse — linha de convite/match
 * gravada pelo sistema (stage INVITED, source diferente de 'manual'; inclui Compatíveis e Invitados).
 * Predicado único: o espelho em SQL é `preIniciadoWjaSql` (BlockedApplicationQueryRepository.ts) e
 * o ON CONFLICT de CreateManualWjaWithEncuadreUseCase; mudar um exige mudar os outros.
 */
export function isPreIniciado(stage: string | null, source: string | null): boolean {
  return stage === 'INVITED' && source !== 'manual';
}

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
  'COMPATIBLE', // candidato do match, sem convite — Fase 5
  'INVITED',
  'INICIADO',
  'PRE_SCREENING',
  'IN_PROGRESS',
  'COMPLETED',
  'CONFIRMED',
  'SELECTED',
  'QUICK_RESPONSE_TEAM', // entrada do quadro C, invariante 1 (Fase 4) — mais avançada que SELECTED
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
 * @param stage      worker_job_applications.application_funnel_stage (nullable)
 * @param source     worker_job_applications.source (nullable) — 'manual' means the worker
 *                   clicked postularse (→ INICIADO), otherwise it's an auto-invite (→ INVITED)
 * @param messagedAt worker_job_applications.messaged_at — obrigatório: decide Compatíveis × Invitados, D432
 */
export function deriveKanbanColumn(
  stage: string | null,
  source: string | null,
  messagedAt: string | Date | null,
): KanbanColumn {
  if (isMatchedNotInvited(stage, source, messagedAt)) return 'COMPATIBLE';
  if (stage === 'SELECTED') return 'SELECTED';
  if (stage === 'QUICK_RESPONSE_TEAM') return 'QUICK_RESPONSE_TEAM';
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

/** Contagem por coluna do Kanban — as MESMAS colunas que o operador vê no board. */
export type FunnelColumnCounts = Record<Exclude<KanbanColumn, 'BLOQUEADO'>, number>;

/** Zero em TODAS as colunas — coluna sem ninguém aparece como 0, nunca ausente. */
export function emptyFunnelColumnCounts(): FunnelColumnCounts {
  const counts = {} as FunnelColumnCounts;
  for (const column of FUNNEL_COLUMNS) {
    counts[column as keyof FunnelColumnCounts] = 0;
  }
  return counts;
}

/** Uma linha já agrupada: candidatura (stage/source/messaged) ou tentativa negada. */
export interface KanbanTallyRow {
  kind: 'wja' | 'blocked';
  /** Só para kind='blocked': tentativa dispensada ("Rechazar") conta em REJECTED, não em INICIADO. */
  dismissed?: boolean;
  stage: string | null;
  source: string | null;
  messaged: boolean;
  n: number;
}

/** Contagem por coluna com os MESMOS recortes do Kanban (WJAFunnelController.getEncuadreFunnel). */
export function tallyKanbanColumns(rows: readonly KanbanTallyRow[]): FunnelColumnCounts {
  const counts = emptyFunnelColumnCounts();
  for (const r of rows) {
    if (r.kind === 'blocked') {
      counts[kanbanColumnForBlocked(r.dismissed === true) as keyof FunnelColumnCounts] += r.n;
      continue;
    }
    counts[deriveKanbanColumn(r.stage, r.source, r.messaged ? 'sent' : null) as keyof FunnelColumnCounts] += r.n;
  }
  return counts;
}

/**
 * Ordem que o operador vê no quadro B (funil de candidatura); base do "salto" (DX-4.5,
 * execucao/fase-4.md) — espelha `VACANCY_FUNNEL_COLUMNS` do front (funnelTabsConfig.ts).
 * IN_PROGRESS mora dentro de PRE_SCREENING no quadro; COMPLETED/QUALIFIED/IN_DOUBT já
 * chegam colapsados em COMPLETED por `deriveKanbanColumn`. BLOQUEADO fica de fora — não
 * tem posição própria no quadro (vira card em INICIADO, ou REJECTED se dispensado, D474).
 * 9 colunas; Compatíveis é derivada, destino proibido — DX-5.5.
 */
export const VACANCY_BOARD_COLUMNS = [
  'COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING', 'COMPLETED', 'CONFIRMED', 'SELECTED', 'QUICK_RESPONSE_TEAM', 'REJECTED',
] as const satisfies readonly KanbanColumn[];

/**
 * Posição no quadro; IN_PROGRESS mora na coluna PRE_SCREENING (como no front,
 * funnelTabsConfig.ts:21) — não tem posição própria em `VACANCY_BOARD_COLUMNS`.
 */
export function boardPosition(
  stage: string | null,
  source: string | null,
  messagedAt: string | Date | null,
): number {
  const column = deriveKanbanColumn(stage, source, messagedAt);
  const boardColumn = column === 'IN_PROGRESS' ? 'PRE_SCREENING' : column;
  return VACANCY_BOARD_COLUMNS.indexOf(boardColumn as (typeof VACANCY_BOARD_COLUMNS)[number]);
}
