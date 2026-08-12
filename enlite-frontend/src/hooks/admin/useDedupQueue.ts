/**
 * useDedupQueue
 *
 * Fetches the list of duplicate worker groups.
 * Pattern mirrors useBlockedAttempts: useState/useEffect/useCallback,
 * no React Query, exposes { data, isLoading, error, refetch }.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import type { DedupGroupSummary } from '@domain/entities/DedupGroup';

export interface UseDedupQueueResult {
  groups: DedupGroupSummary[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useDedupQueue(): UseDedupQueueResult {
  const [groups, setGroups] = useState<DedupGroupSummary[]>([]);
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

        const data = await AdminDedupApiService.getGroups();
        if (cancelled) return;

        setGroups(data);
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : 'Error al cargar grupos de duplicados';
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

  return { groups, isLoading, error, refetch };
}
