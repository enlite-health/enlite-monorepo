import { useState, useEffect, useCallback } from 'react';
import { AdminApiService, WorkerDateStats } from '@infrastructure/http/AdminApiService';
import type { WorkerListFilters } from '@infrastructure/http/AdminWorkerListApiService';

export type { WorkerListFilters };

const STATS_FALLBACK: WorkerDateStats = { today: 0, yesterday: 0, sevenDaysAgo: 0 };

export function useWorkersData(filters?: WorkerListFilters) {
  const [workers, setWorkers] = useState<unknown[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<WorkerDateStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    async function fetchData(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);

        const [workersResult, statsResult] = await Promise.all([
          AdminApiService.listWorkers(filters),
          AdminApiService.getWorkerDateStats().catch(() => STATS_FALLBACK),
        ]);

        setWorkers(workersResult.data ?? []);
        setTotal(workersResult.total ?? 0);
        setStats(statsResult);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to fetch workers';
        setError(msg);
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters?.platform,
    filters?.docs_complete,
    filters?.docs_validated,
    filters?.search,
    filters?.case_id,
    filters?.tag_ids,
    filters?.limit,
    filters?.offset,
    filters?.profession,
    filters?.preferred_age_range,
    filters?.experience_type,
    filters?.preferred_type,
    filters?.language,
    filters?.sex,
    filters?.state,
    filters?.city,
    filters?.days,
    refreshKey,
  ]);

  return { workers, total, stats, isLoading, error, refetch };
}
