import { useState, useEffect, useCallback } from 'react';
import { ManagementDashboardApiService } from '@infrastructure/http/ManagementDashboardApiService';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

interface UseManagementDashboardResult {
  data: ManagementDashboardData | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useManagementDashboard(): UseManagementDashboardResult {
  const [data, setData] = useState<ManagementDashboardData | null>(null);
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
        const result = await ManagementDashboardApiService.getManagementDashboard();
        if (!cancelled) setData(result);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch management dashboard');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return { data, isLoading, error, refetch };
}
