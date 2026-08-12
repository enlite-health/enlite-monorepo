/**
 * useImportedGroups
 *
 * Fetches the list of name-based duplicate groups (Onda 4b).
 * Pattern mirrors useDedupQueue: useState/useEffect/useCallback,
 * no React Query, exposes { groups, isLoading, error, refetch }.
 *
 * Extra: onlyWithReal toggle (default true — shows only real↔imported groups,
 * the 142 priority cases). When false, also shows imported↔imported groups.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import type { ImportedDedupGroup } from '@domain/entities/DedupGroup';

export interface UseImportedGroupsResult {
  groups: ImportedDedupGroup[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  onlyWithReal: boolean;
  setOnlyWithReal: (value: boolean) => void;
}

export function useImportedGroups(): UseImportedGroupsResult {
  const [groups, setGroups] = useState<ImportedDedupGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [onlyWithReal, setOnlyWithReal] = useState(true);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function fetchData(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);

        const data = await AdminDedupApiService.getImportedGroups(onlyWithReal);
        if (cancelled) return;

        setGroups(data);
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err instanceof Error
              ? err.message
              : 'Error al cargar grupos importados';
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
  }, [onlyWithReal, refreshKey]);

  return { groups, isLoading, error, refetch, onlyWithReal, setOnlyWithReal };
}
