export type FunnelBucket =
  | 'INVITED'
  | 'POSTULATED'
  | 'PRE_SELECTED'
  | 'REJECTED'
  | 'WITHDREW'
  | 'ALL';

export type WhatsappStatus =
  | 'NOT_SENT'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'REPLIED';

export interface FunnelTableRow {
  id: string;
  workerId: string;
  workerName: string | null;
  workerEmail: string | null;
  workerPhone: string | null;
  workerAvatarUrl: string | null;
  invitedAt: string; // ISO
  funnelStage: string | null;
  whatsappStatus: WhatsappStatus | null;
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

export interface FunnelTableData {
  rows: FunnelTableRow[];
  counts: FunnelTableCounts;
}

export interface FunnelTableResponse {
  rows: FunnelTableRow[];
  counts: FunnelTableCounts;
}
