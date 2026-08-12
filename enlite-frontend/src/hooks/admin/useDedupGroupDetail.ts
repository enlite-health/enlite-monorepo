/**
 * useDedupGroupDetail
 *
 * Fetches the field-level comparison detail for a single duplicate group.
 * Also exposes merge/dismiss mutations with their own loading/error state.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import type {
  DedupGroupDetail,
  MergeRequest,
  MergeResult,
  DismissRequest,
  DismissResult,
} from '@domain/entities/DedupGroup';

export interface UseDedupGroupDetailResult {
  detail: DedupGroupDetail | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;

  /** Merge mutation */
  isMerging: boolean;
  mergeError: string | null;
  merge: (payload: MergeRequest) => Promise<MergeResult>;

  /** Dismiss mutation */
  isDismissing: boolean;
  dismissError: string | null;
  dismiss: (payload: DismissRequest) => Promise<DismissResult>;
}

export function useDedupGroupDetail(
  phoneNormalized: string | null,
): UseDedupGroupDetailResult {
  const [detail, setDetail] = useState<DedupGroupDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const [isDismissing, setIsDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!phoneNormalized) {
      setDetail(null);
      return;
    }

    let cancelled = false;

    async function fetchData(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);

        const data = await AdminDedupApiService.getGroupDetail(phoneNormalized!);
        if (cancelled) return;

        setDetail(data);
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err instanceof Error
              ? err.message
              : 'Error al cargar detalle del grupo';
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
  }, [phoneNormalized, refreshKey]);

  const merge = useCallback(async (payload: MergeRequest): Promise<MergeResult> => {
    setIsMerging(true);
    setMergeError(null);
    try {
      const result = await AdminDedupApiService.merge(payload);
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Error al ejecutar el merge';
      setMergeError(message);
      throw err;
    } finally {
      setIsMerging(false);
    }
  }, []);

  const dismiss = useCallback(async (payload: DismissRequest): Promise<DismissResult> => {
    setIsDismissing(true);
    setDismissError(null);
    try {
      const result = await AdminDedupApiService.dismiss(payload);
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Error al descartar el grupo';
      setDismissError(message);
      throw err;
    } finally {
      setIsDismissing(false);
    }
  }, []);

  return {
    detail,
    isLoading,
    error,
    refetch,
    isMerging,
    mergeError,
    merge,
    isDismissing,
    dismissError,
    dismiss,
  };
}
