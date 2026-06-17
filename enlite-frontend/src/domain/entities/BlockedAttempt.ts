/**
 * Domain entities for blocked application attempts.
 * Source: BlockedApplicationQueryRepository (migration 209).
 */

export type BlockedReason =
  | 'registration_incomplete'
  | 'worker_disabled'
  | 'worker_not_found';

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
