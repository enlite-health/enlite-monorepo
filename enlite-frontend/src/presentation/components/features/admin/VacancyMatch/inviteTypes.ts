import type { FunnelTableRow } from '@domain/entities/Funnel';

export interface InviteTarget {
  workerId: string;
  workerName: string;
  messagedAt: string | null;
}

/**
 * Só chamadores que já filtraram `workerId !== null` (linha redigida de Compatíveis,
 * DX-5.7, `Funnel.ts:19-20` — não se aplica ao bucket INVITED que este alvo serve).
 */
export function funnelRowToInviteTarget(row: FunnelTableRow & { workerId: string }): InviteTarget {
  return {
    workerId: row.workerId,
    workerName: row.workerName ?? row.workerId,
    messagedAt: row.whatsappLastDispatchedAt ?? null,
  };
}
