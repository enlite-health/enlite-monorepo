import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import type { EncuadreRole } from '@domain/entities/EncuadreRole';

export interface MoveEncuadreError {
  message: string;
  code?: string;
  reason?: string;
  workerStatus?: string | null;
}

const POLL_INTERVAL_MS = 5_000;

interface FunnelEncuadre {
  id: string;
  /** encuadreId is null for WJAs that have no encuadre yet (orphans or blocked attempts). Drag is blocked in that case. */
  encuadreId: string | null;
  workerId: string | null;
  workerName: string | null;
  workerPhone: string | null;
  occupation: string | null;
  interviewDate: string | null;
  interviewTime: string | null;
  meetLink: string | null;
  /** F7.b: interview_response from worker_job_applications — 'awaiting_reschedule' signals reschedule request */
  interviewResponse?: string | null;
  resultado: string | null;
  attended: boolean | null;
  rejectionReasonCategory: string | null;
  rejectionReason: string | null;
  matchScore: number | null;
  talentumStatus: string | null;
  workZone: string | null;
  redireccionamiento: string | null;
  acquisitionChannel?: string | null;
  internalStage?: string | null;
  /** INICIADO column: true when the worker was blocked by the gate (worker_blocked_applications) */
  isBlocked?: boolean;
  /** Reason the gate blocked the attempt: worker_not_found | registration_incomplete | worker_disabled */
  blockedReason?: string;
  /** List of field keys that need to be completed for registration_incomplete */
  missingFields?: string[];
  /** How many times this worker attempted to apply to this vacancy */
  attemptCount?: number;
  /** Number of contact notes (comentários) registered for this WJA. 0 for blocked cards. */
  contactNotesCount?: number;
  /** ISO de quando o próprio prestador entrou na vaga pelo link (null = desconhecido). */
  selfAppliedAt?: string | null;
  /** ISO do último envio de WhatsApp a esta candidatura (manual ou em lote); null = nunca. REQ-08. */
  lastMessagedAt?: string | null;
  /** PEND-14/DEC-12: último template enfileirado POR ETAPA para esta candidatura (trilha Luz × humano). */
  lastStageMessage?: { stage: string; templateSlug: string | null; at: string } | null;
  /**
   * D200.1: por que o "Reenviar" está desabilitado AGORA (null = livre). Calculado pelo
   * backend com a MESMA janela do 422 — o card não deixa clicar onde o clique seria recusado.
   */
  resendBlockedReason?: { code: string; until: string } | null;
  /** Blocked card que foi "rechazado" (soft-dismiss): aparece em RECHAZADOS, com botão de voltar. */
  isDismissed?: boolean;
}

export interface FunnelStages {
  INVITED: FunnelEncuadre[];
  /** Blocked postulation attempts (worker_blocked_applications) — no encuadreId, cards are drag-disabled */
  BLOQUEADO: FunnelEncuadre[];
  INICIADO: FunnelEncuadre[];
  PRE_SCREENING: FunnelEncuadre[];
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

export function useWJAFunnel(vacancyId: string | undefined) {
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
    role?: EncuadreRole,
    /** Data/hora da entrevista ao agendar. Ausente = "ainda não sei" (válido). */
    schedule?: { interviewDate: string; interviewTime: string; interviewMeetLink?: string },
  ): Promise<MoveEncuadreError | null> => {
    try {
      await AdminApiService.moveEncuadre(encuadreId, {
        targetStage,
        rejectionReasonCategory,
        role,
        ...schedule,
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

  /**
   * "Rechazar" um card BLOQUEADO: promove a tentativa bloqueada para RECHAZADOS com o
   * motivo escolhido. Escopo estrito à vaga — não toca no cadastro nem em outras vagas.
   * Após rejeitar, refaz o fetch (o card sai de BLOQUEADO e aparece em RECHAZADOS).
   */
  const rejectBlocked = useCallback(async (
    blockedId: string,
    rejectionReasonCategory: string,
  ): Promise<MoveEncuadreError | null> => {
    try {
      await AdminApiService.rejectBlockedAttempt(blockedId, { rejectionReasonCategory });
      await fetchFunnel();
      return null;
    } catch (err) {
      console.error('Failed to reject blocked application:', err);
      if (err instanceof ApiError) {
        return { message: err.message, code: err.code, reason: err.reason, workerStatus: err.workerStatus };
      }
      return { message: err instanceof Error ? err.message : 'Erro desconhecido' };
    }
  }, [fetchFunnel]);

  /**
   * "Voltar a bloqueados": desfaz o rechazo de um card bloqueado (RECHAZADOS → BLOQUEADO).
   */
  const unrejectBlocked = useCallback(async (blockedId: string): Promise<MoveEncuadreError | null> => {
    try {
      await AdminApiService.restoreBlockedAttempt(blockedId);
      await fetchFunnel();
      return null;
    } catch (err) {
      console.error('Failed to restore blocked application:', err);
      if (err instanceof ApiError) {
        return { message: err.message, code: err.code, reason: err.reason, workerStatus: err.workerStatus };
      }
      return { message: err instanceof Error ? err.message : 'Erro desconhecido' };
    }
  }, [fetchFunnel]);

  return { data, isLoading, error, refetch: fetchFunnel, moveEncuadre, rejectBlocked, unrejectBlocked };
}
