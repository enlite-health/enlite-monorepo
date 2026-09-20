/**
 * Domain entities for blocked application attempts.
 * Source: BlockedApplicationQueryRepository (migration 209).
 */

/**
 * `eligible` = a pessoa passaria no gate AGORA — a ausência de bloqueio, não um
 * bloqueio. Nasceu quando o motivo passou a ser recalculado na leitura (D300).
 * Sem ele aqui, o painel exibia o balde no topo e não deixava filtrar por ele.
 */
export type BlockedReason =
  | 'registration_incomplete'
  | 'worker_disabled'
  | 'worker_not_found'
  | 'eligible';

export interface BlockedAttempt {
  id: string;
  workerId: string;
  jobPostingId: string;
  blockedReason: BlockedReason;
  missingFields: string[];
  attemptCount: number;
  firstAttemptedAt: string;
  lastAttemptedAt: string;
  acquisitionChannel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlockedAggregates {
  totalBlocked: number;
  byReason: Record<string, number>;
}

export interface BlockedAttemptsPagination {
  total: number;
  limit: number;
  offset: number;
  page: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface BlockedAttemptsResponse {
  data: BlockedAttempt[];
  aggregates: BlockedAggregates;
  pagination: BlockedAttemptsPagination;
}

export interface BlockedAttemptsFilters {
  jobPostingId?: string;
  workerId?: string;
  reason?: BlockedReason;
  page?: number;
  limit?: number;
}
