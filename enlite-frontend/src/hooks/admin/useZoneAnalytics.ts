import { useState, useEffect, useCallback } from 'react';
import { ZoneAnalyticsApiService } from '@infrastructure/http/ZoneAnalyticsApiService';
import type { ZoneAnalyticsData } from '@domain/entities/ZoneAnalytics';
import type { WorkerProfession } from '@domain/entities/Worker';

interface UseZoneAnalyticsResult {
  data: ZoneAnalyticsData | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Busca o bloco "Analytics por Zona" (GET /analytics/dashboard/zone-analytics).
 * Refetch automático quando `profession` muda — é a dimensão de filtro/BI
 * pedida pra essa seção do Dashboard de Gestão à Vista.
 */
export function useZoneAnalytics(profession?: WorkerProfession): UseZoneAnalyticsResult {
  const [data, setData] = useState<ZoneAnalyticsData | null>(null);
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
        const result = await ZoneAnalyticsApiService.getZoneAnalytics(profession);
        if (!cancelled) setData(result);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch zone analytics');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [profession, refreshKey]);

  return { data, isLoading, error, refetch };
}
