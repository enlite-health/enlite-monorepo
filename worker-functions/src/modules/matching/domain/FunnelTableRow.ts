/**
 * Domain types for the vacancy funnel audit table.
 *
 * GET /api/admin/vacancies/:id/funnel-table
 * Returns a flat list of all candidates for a vacancy with WhatsApp delivery
 * status and interview response, grouped into counted buckets.
 */

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
}

export interface FunnelTableCounts {
  INVITED: number;
  POSTULATED: number;
  PRE_SELECTED: number;
  REJECTED: number;
  WITHDREW: number;
  ALL: number;
}

export interface FunnelTableResult {
  rows: FunnelTableRow[];
  counts: FunnelTableCounts;
}
