import { useState, useEffect, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

interface UseVacanciesDataFilters {
  search?: string;
  status?: string;
  priority?: string;
  limit?: string;
  offset?: string;
}

export function useVacanciesData(filters?: UseVacanciesDataFilters) {
  const [vacancies, setVacancies] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);
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
      } catch (err: any) {
        setError(err.message || 'Failed to fetch vacancies data');
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters?.search, filters?.status, filters?.priority, filters?.limit, filters?.offset, fetchKey]);

  return {
    vacancies,
    stats,
    total,
    isLoading,
    error,
    refetch,
  };
}
