import { useState, useEffect, useCallback } from 'react';
import { AdminRecruitmentApiService } from '@infrastructure/http/AdminRecruitmentApiService';
import type { RecruitmentHealthData } from '@domain/entities/RecruitmentHealth';

interface UseRecruitmentHealthResult {
  data: RecruitmentHealthData | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useRecruitmentHealth(): UseRecruitmentHealthResult {
  const [data, setData] = useState<RecruitmentHealthData | null>(null);
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
        const result = await AdminRecruitmentApiService.getRecruitmentHealth();
        if (!cancelled) {
          setData(result);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to fetch recruitment health';
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
  }, [refreshKey]);

  return { data, isLoading, error, refetch };
}
