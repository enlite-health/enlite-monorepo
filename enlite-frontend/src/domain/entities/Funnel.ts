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
  registrationComplete: boolean;
  contactNotesCount: number;
  /**
   * ISO de quando o PRÓPRIO prestador entrou nesta vaga pelo link público.
   * null = não sabemos (autoria só é gravada desde 06/08) — ausência NÃO é
   * prova de desinteresse.
   */
  selfAppliedAt?: string | null;
  /** Coluna derivada do Kanban (DX-2.2) para esta linha; null quando o backend não a calcula (bucket sem coluna). */
  kanbanColumn: string | null;
  /** true quando a linha é uma tentativa negada (worker_blocked_applications), não uma candidatura (WJA). */
  isBlocked: boolean;
  /** km do candidato até a vaga (DX-3.10); ausente/null = tentativa negada ou sem geocoding. */
  distanceKm?: number | null;
}

export interface FunnelTableCounts {
  INVITED: number;
  POSTULATED: number;
  PRE_SELECTED: number;
  REJECTED: number;
  WITHDREW: number;
  ALL: number;
  /** Contagem por coluna derivada do Kanban (DX-2.3), chaves = VacancyFunnelColumnId + 'IN_PROGRESS'. */
  columns: Record<string, number>;
}

export interface FunnelTableData {
  rows: FunnelTableRow[];
  counts: FunnelTableCounts;
}

export interface FunnelTableResponse {
  rows: FunnelTableRow[];
  counts: FunnelTableCounts;
}
