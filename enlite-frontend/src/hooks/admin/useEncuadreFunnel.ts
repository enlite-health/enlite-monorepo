import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { ApiError } from '@infrastructure/http/ApiError';

export interface MoveEncuadreError {
  message: string;
  code?: string;
  reason?: string;
  workerStatus?: string | null;
}

const POLL_INTERVAL_MS = 5_000;

interface FunnelEncuadre {
  id: string;
  /** encuadreId is null for WJAs that have no encuadre yet (orphans). Drag is blocked in that case. */
  encuadreId: string | null;
  workerId: string | null;
  workerName: string | null;
  workerPhone: string | null;
  occupation: string | null;
  interviewDate: string | null;
  interviewTime: string | null;
  meetLink: string | null;
  resultado: string | null;
  attended: boolean | null;
  rejectionReasonCategory: string | null;
  rejectionReason: string | null;
  matchScore: number | null;
  talentumStatus: string | null;
  workZone: string | null;
  redireccionamiento: string | null;
  funnelStage: string | null;
  acquisitionChannel?: string | null;
  internalStage?: string | null;
}

export interface FunnelStages {
  INVITED: FunnelEncuadre[];
  INITIATED: FunnelEncuadre[];
  IN_PROGRESS: FunnelEncuadre[];
  COMPLETED: FunnelEncuadre[];
  CONFIRMED: FunnelEncuadre[];
  SELECTED: FunnelEncuadre[];
  REJECTED: FunnelEncuadre[];
}

interface FunnelData {
  stages: FunnelStages;
  totalEncuadres: number;
}

export function useEncuadreFunnel(vacancyId: string | undefined) {
  const [data, setData] = useState<FunnelData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchFunnel = useCallback(async (silent = false) => {
    if (!vacancyId || isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      const response = await AdminApiService.getEncuadreFunnel(vacancyId) as FunnelData;
      setData(response);
      if (!silent) setError(null);
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load funnel');
    } finally {
      if (!silent) setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, [vacancyId]);

  // Fetch inicial + polling a cada 5s — limpa ao sair da tela
  useEffect(() => {
    fetchFunnel();
    const intervalId = setInterval(() => fetchFunnel(true), POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [fetchFunnel]);

  const moveEncuadre = useCallback(async (
    encuadreId: string,
    targetStage: string,
    rejectionReasonCategory?: string,
  ): Promise<MoveEncuadreError | null> => {
    try {
      await AdminApiService.moveEncuadre(encuadreId, {
        targetStage,
        rejectionReasonCategory,
      });
      await fetchFunnel();
      return null;
    } catch (err) {
      console.error('Failed to move encuadre:', err);
      if (err instanceof ApiError) {
        return {
          message: err.message,
          code: err.code,
          reason: err.reason,
          workerStatus: err.workerStatus,
        };
      }
      return {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
      };
    }
  }, [fetchFunnel]);

  return { data, isLoading, error, refetch: fetchFunnel, moveEncuadre };
}
