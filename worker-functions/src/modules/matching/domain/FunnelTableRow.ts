/**
 * Domain types for the vacancy funnel audit table.
 *
 * GET /api/admin/vacancies/:id/funnel-table
 * Returns a flat list of all candidates for a vacancy with WhatsApp delivery
 * status and interview response, grouped into counted buckets.
 */

import type { KanbanColumn, FunnelColumnCounts } from './kanbanColumn';

export type WhatsAppStatus =
  | 'NOT_SENT'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'REPLIED';

export type FunnelBucket =
  | 'INVITED'
  | 'POSTULATED'
  | 'PRE_SELECTED'
  | 'REJECTED'
  | 'WITHDREW'
  | 'ALL';

export interface FunnelTableRow {
  id: string;
  workerId: string;
  workerName: string | null;
  workerEmail: string | null;
  workerPhone: string | null;
  workerAvatarUrl: string | null;
  invitedAt: string;
  funnelStage: string | null;
  whatsappStatus: WhatsAppStatus | null;
  whatsappLastDispatchedAt: string | null;
  accepted: boolean | null;
  interviewResponse: string | null;
  registrationComplete: boolean;
  contactNotesCount: number;
  /**
   * ISO do momento em que o PRÓPRIO prestador entrou nesta vaga pelo link
   * público. null = não sabemos (a autoria só é gravada desde 06/08 — card
   * antigo sem carimbo não prova ausência de interesse).
   */
  selfAppliedAt: string | null;
  /** Coluna do Kanban (D433: tentativa negada = REJECTED) — null quando fora do board (match candidate). */
  kanbanColumn: Exclude<KanbanColumn, 'BLOQUEADO'> | null;
  /** true quando a linha veio de worker_blocked_applications (fetchBlockedRawRows), não de WJA. */
  isBlocked: boolean;
  /** km até a vaga (DX-3.10); null = sem coordenada ou tentativa negada. */
  distanceKm: number | null;
}

export interface FunnelTableCounts {
  INVITED: number;
  POSTULATED: number;
  PRE_SELECTED: number;
  REJECTED: number;
  WITHDREW: number;
  ALL: number;
  /** As 8 contagens do Kanban, mesmo recorte do board — para as abas do modo lista (DX-2.6). */
  columns: FunnelColumnCounts;
}

export interface FunnelTableResult {
  rows: FunnelTableRow[];
  counts: FunnelTableCounts;
}
