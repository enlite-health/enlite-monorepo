/**
 * restoreTitular — restaura o titular que foi `CANCELLED` por ainda não ter começado (D1), fonte única do "tirar" com destino
 * (`RemoveFromItineraryUseCase`) e do desfazer do "No vuelve más" (`UndoSubstitutionRequestUseCase`, spec 069 T304/T306).
 *
 * A restauração pode bater em DUAS barreiras do banco, e nenhuma pode virar 500:
 *  - Trava A / sobreposição (482/484) → o erro de domínio da sobreposição (`fromPgError`);
 *  - `uq_pia_open_pair` (23505, defeito 17 / FR-34): a mesma pessoa já está aberta na faixa → `AllocationRestoreConflictError`
 *    (409 `ALLOCATION_RESTORE_CONFLICT`). O 23505 de OUTRA constraint segue cru (é bug, não conflito).
 */
import type { PoolClient } from 'pg';
import { fromPgError, type PgOverlapLikeError } from '../domain/itineraryOverlap';
import { isOpenPairConflict } from './ItineraryAllocationUseCase';

/** A restauração do titular bateu em `uq_pia_open_pair`: ele já tem uma alocação aberta nesta faixa. */
export class AllocationRestoreConflictError extends Error {
  constructor(readonly allocationId: string) {
    super(`Cannot restore allocation, the worker already has an open allocation in the slot: ${allocationId}`);
    this.name = 'AllocationRestoreConflictError';
  }
}

/**
 * O erro de domínio de uma escrita que REABRE o titular (restore ou solta o fim), ou `null` se o erro não é dessas barreiras. Fonte única
 * do mapeamento: sobreposição/Trava A (`fromPgError`) e o par aberto (`uq_pia_open_pair`).
 */
export function reopenErrorFrom(err: unknown, allocationId: string): Error | null {
  const overlap = fromPgError(err as PgOverlapLikeError);
  if (overlap !== null) return overlap;
  return isOpenPairConflict(err) ? new AllocationRestoreConflictError(allocationId) : null;
}

export interface RestoreTitularPort {
  restoreCancelled(client: PoolClient, id: string, minValidFrom: string, actorUid: string): Promise<number>;
}

export async function restoreTitular(schedule: RestoreTitularPort, client: PoolClient, id: string, minValidFrom: string, actorUid: string): Promise<void> {
  try {
    await schedule.restoreCancelled(client, id, minValidFrom, actorUid);
  } catch (err) {
    throw reopenErrorFrom(err, id) ?? err;
  }
}
