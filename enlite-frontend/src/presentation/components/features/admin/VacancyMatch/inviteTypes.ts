import type { FunnelTableRow } from '@domain/entities/Funnel';

export interface InviteTarget {
  workerId: string;
  workerName: string;
  messagedAt: string | null;
}

export function funnelRowToInviteTarget(row: FunnelTableRow): InviteTarget {
  return {
    workerId: row.workerId,
    workerName: row.workerName ?? row.workerId,
    messagedAt: row.whatsappLastDispatchedAt ?? null,
  };
}
