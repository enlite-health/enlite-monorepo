/**
 * useBlockedAttempts
 *
 * Fetches paginaged blocked application attempts and their aggregates.
 * Resolves worker names and vacancy titles via parallel calls (deduped).
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminRecruitmentApiService } from '@infrastructure/http/AdminRecruitmentApiService';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type {
  BlockedAttempt,
  BlockedAggregates,
  BlockedAttemptsPagination,
  BlockedAttemptsFilters,
} from '@domain/entities/BlockedAttempt';

export interface ResolvedAttempt extends BlockedAttempt {
  workerName: string | null;
  vacancyTitle: string | null;
  vacancyCaseNumber: number | null;
}

interface UseBlockedAttemptsResult {
  attempts: ResolvedAttempt[];
  aggregates: BlockedAggregates;
  pagination: BlockedAttemptsPagination;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const DEFAULT_AGGREGATES: BlockedAggregates = { totalBlocked: 0, byReason: {} };
const DEFAULT_PAGINATION: BlockedAttemptsPagination = {
  total: 0,
  limit: 20,
  offset: 0,
  page: 1,
  totalPages: 0,
  hasNext: false,
  hasPrev: false,
};

/**
 * Resolves a set of worker IDs → { firstName, lastName } in parallel,
 * deduplicating IDs to avoid N+1.
 */
async function resolveWorkerNames(
  ids: string[],
): Promise<Record<string, string | null>> {
  const unique = [...new Set(ids)];
  const results = await Promise.all(
    unique.map(async (id) => {
      try {
        const w = await AdminApiService.getWorkerById(id);
        const name =
          w.firstName && w.lastName
            ? `${w.firstName} ${w.lastName}`
            : (w.firstName ?? w.lastName ?? null);
        return [id, name] as const;
      } catch {
        return [id, null] as const;
      }
    }),
  );
  return Object.fromEntries(results);
}

/**
 * Resolves a set of vacancy IDs → { title, case_number } in parallel,
 * deduplicating IDs.
 */
async function resolveVacancies(
  ids: string[],
): Promise<Record<string, { title: string | null; caseNumber: number | null }>> {
  const unique = [...new Set(ids)];
  const results = await Promise.all(
    unique.map(async (id) => {
      try {
        const v = await AdminApiService.getVacancyById(id);
        return [
          id,
          {
            title: (v.title as string | null) ?? null,
            caseNumber: (v.case_number as number | null) ?? null,
          },
        ] as const;
      } catch {
        return [id, { title: null, caseNumber: null }] as const;
      }
    }),
  );
  return Object.fromEntries(results);
}

export function useBlockedAttempts(
  filters: BlockedAttemptsFilters = {},
): UseBlockedAttemptsResult {
  const [attempts, setAttempts] = useState<ResolvedAttempt[]>([]);
  const [aggregates, setAggregates] = useState<BlockedAggregates>(DEFAULT_AGGREGATES);
  const [pagination, setPagination] =
    useState<BlockedAttemptsPagination>(DEFAULT_PAGINATION);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function fetchData(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);

        const response = await AdminRecruitmentApiService.getBlockedAttempts(filters);
        if (cancelled) return;

        const raw = response.data;

        // Deduplicate IDs before resolving
        const workerIds = raw.map((a) => a.workerId);
        const vacancyIds = raw.map((a) => a.jobPostingId);

        const [workerNames, vacancies] = await Promise.all([
          resolveWorkerNames(workerIds),
          resolveVacancies(vacancyIds),
        ]);

        if (cancelled) return;

        const resolved: ResolvedAttempt[] = raw.map((a) => ({
          ...a,
          workerName: workerNames[a.workerId] ?? null,
          vacancyTitle: vacancies[a.jobPostingId]?.title ?? null,
          vacancyCaseNumber: vacancies[a.jobPostingId]?.caseNumber ?? null,
        }));

        setAttempts(resolved);
        setAggregates(response.aggregates);
        setPagination(response.pagination);
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : 'Failed to fetch blocked attempts';
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.jobPostingId,
    filters.workerId,
    filters.reason,
    filters.page,
    filters.limit,
    refreshKey,
  ]);

  return { attempts, aggregates, pagination, isLoading, error, refetch };
}
