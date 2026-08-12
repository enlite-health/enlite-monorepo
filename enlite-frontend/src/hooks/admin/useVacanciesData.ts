import { useState, useEffect, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

export interface UseVacanciesDataFilters {
  search?: string;
  status?: string;
  priority?: string;
  limit?: string;
  offset?: string;
  worker_type?: string;
  state?: string;
  city?: string;
  required_sex?: string;
  days?: string;     // CSV of ints, e.g. "1,3,5"
  time_from?: string;
  time_to?: string;
}

export function useVacanciesData(filters?: UseVacanciesDataFilters) {
  const [vacancies, setVacancies] = useState<unknown[]>([]);
  const [stats, setStats] = useState<unknown[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  const refetch = useCallback(() => setFetchKey((k) => k + 1), []);

  useEffect(() => {
    async function fetchData(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);

        const [vacanciesData, statsData] = await Promise.all([
          AdminApiService.listVacancies(filters),
          AdminApiService.getVacanciesStats()
        ]);

        setVacancies(vacanciesData.data || []);
        setTotal(vacanciesData.total || 0);
        setStats(statsData || []);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to fetch vacancies data';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters?.search,
    filters?.status,
    filters?.priority,
    filters?.limit,
    filters?.offset,
    filters?.worker_type,
    filters?.state,
    filters?.city,
    filters?.required_sex,
    filters?.days,
    filters?.time_from,
    filters?.time_to,
    fetchKey,
  ]);

  return {
    vacancies,
    stats,
    total,
    isLoading,
    error,
    refetch,
  };
}
