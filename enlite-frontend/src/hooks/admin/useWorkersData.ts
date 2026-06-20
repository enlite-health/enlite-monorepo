import { useState, useEffect, useCallback } from 'react';
import { AdminApiService, WorkerDateStats } from '@infrastructure/http/AdminApiService';

interface UseWorkersDataFilters {
  platform?: string;
  docs_complete?: string;
  docs_validated?: 'all_validated' | 'pending_validation' | undefined;
  search?: string;
  case_id?: string;
  tag_ids?: string;
  limit?: string;
  offset?: string;
}

const STATS_FALLBACK: WorkerDateStats = { today: 0, yesterday: 0, sevenDaysAgo: 0 };

export function useWorkersData(filters?: UseWorkersDataFilters) {
  const [workers, setWorkers] = useState<any[]>([]);
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
      } catch (err: any) {
        setError(err.message || 'Failed to fetch workers');
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters?.platform, filters?.docs_complete, filters?.docs_validated, filters?.search, filters?.case_id, filters?.tag_ids, filters?.limit, filters?.offset, refreshKey]);

  return { workers, total, stats, isLoading, error, refetch };
}
