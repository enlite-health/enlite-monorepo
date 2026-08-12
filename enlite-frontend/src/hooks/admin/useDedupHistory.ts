/**
 * useDedupHistory
 *
 * Fetches the list of executed merges and exposes the undo mutation.
 * Pattern mirrors useDedupQueue / useDedupGroupDetail:
 *   - useState/useEffect/useCallback, no React Query.
 *   - Separate loading/error state for the undo mutation.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import type { MergeHistoryItem } from '@domain/entities/DedupGroup';

export interface UseDedupHistoryResult {
  history: MergeHistoryItem[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;

  /** Undo mutation */
  isUndoing: boolean;
  undoError: string | null;
  undo: (auditId: string) => Promise<void>;
}

export function useDedupHistory(): UseDedupHistoryResult {
  const [history, setHistory] = useState<MergeHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [isUndoing, setIsUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function fetchData(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);

        const data = await AdminDedupApiService.getHistory();
        if (cancelled) return;

        setHistory(data);
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err instanceof Error
              ? err.message
              : 'Error al cargar el historial de unificaciones';
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

  const undo = useCallback(
    async (auditId: string): Promise<void> => {
      setIsUndoing(true);
      setUndoError(null);
      try {
        await AdminDedupApiService.undoMerge(auditId);
        refetch();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Error al deshacer la unificación';
        setUndoError(message);
        throw err;
      } finally {
        setIsUndoing(false);
      }
    },
    [refetch],
  );

  return { history, isLoading, error, refetch, isUndoing, undoError, undo };
}
