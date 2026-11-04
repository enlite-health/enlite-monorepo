import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import type { SubstitutionRequestItem, SubstitutionWhen } from '@domain/entities/SubstitutionRequest';
import { isForbiddenError } from './contractedServiceActionError';

export type SubstitutionRequestsStatus = 'idle' | 'loading' | 'ok' | 'forbidden' | 'error';

export interface UseSubstitutionRequestsResult {
  /** `null` enquanto carrega (a lista nunca mostra pedidos de OUTRO filtro). */
  requests: SubstitutionRequestItem[] | null;
  status: SubstitutionRequestsStatus;
  refresh: () => void;
}

/**
 * A aba "Sustituciones" (spec 069, FR-20): os pedidos do serviço, Próximas ou Pasadas. Tudo derivado no servidor (tipo, período,
 * "Entra", "Ajustado", `undoable`); o hook só carrega. Mesmo padrão de `useServiceOccurrences`: guarda por `requestIdRef`, 403 →
 * `forbidden`, `refreshKey` invalida depois de uma escrita fora do hook.
 */
export function useSubstitutionRequests(patientId: string, serviceId: string, when: SubstitutionWhen, refreshKey = 0): UseSubstitutionRequestsResult {
  const [requests, setRequests] = useState<SubstitutionRequestItem[] | null>(null);
  const [status, setStatus] = useState<SubstitutionRequestsStatus>('idle');
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setRequests(null);
    setStatus('loading');
    AdminSubstitutionRequestsApiService.list(patientId, serviceId, when)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setRequests(result.requests);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setStatus(isForbiddenError(err) ? 'forbidden' : 'error');
      });
  }, [patientId, serviceId, when]);

  // `refreshKey` só invalida: refaz o GET sem ser lido dentro de `load`.
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return { requests, status, refresh: load };
}
