import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { FunnelBucket, FunnelTableData } from '@domain/entities/Funnel';

const POLL_INTERVAL_MS = 10_000;

export function useVacancyFunnelTable(
  vacancyId: string | undefined,
  bucket: FunnelBucket,
  enabled: boolean,
) {
  const [data, setData] = useState<FunnelTableData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchTable = useCallback(
    async (silent = false) => {
      if (!vacancyId || !enabled || isFetchingRef.current) return;
      isFetchingRef.current = true;
      try {
        if (!silent) {
          setIsLoading(true);
          setError(null);
        }
        const response = await AdminApiService.getVacancyFunnelTable(
          vacancyId,
          bucket,
        );
        setData(response);
        if (!silent) setError(null);
      } catch (err) {
        if (!silent)
          setError(
            err instanceof Error ? err.message : 'Failed to load funnel table',
          );
      } finally {
        if (!silent) setIsLoading(false);
        isFetchingRef.current = false;
      }
    },
    [vacancyId, bucket, enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    fetchTable();
    const intervalId = setInterval(() => fetchTable(true), POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [fetchTable, enabled]);

  return { data, isLoading, error, refetch: fetchTable };
}
