import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { ItineraryOverlapDetail, PatientItinerary } from '@domain/entities/PatientItinerary';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';

export type PatientItineraryStatus = 'idle' | 'loading' | 'ok' | 'forbidden' | 'error';

/** Erro de uma ação que a API explicou por `code` (409/422). `overlap` só no 409 `ITINERARY_OVERLAP`. */
export interface ItineraryActionError {
  code: string;
  overlap?: ItineraryOverlapDetail;
}

/** Resultado de `loadOptions`: o modal guarda no próprio estado (o hook não pinta nada com ele). */
export type AllocationOptionsLoad =
  | { status: 'ok'; options: ServiceTeamMember[] }
  | { status: 'forbidden' | 'error' };

export interface UsePatientItineraryResult {
  itinerary: PatientItinerary | null;
  status: PatientItineraryStatus;
  loadOptions: (serviceId: string) => Promise<AllocationOptionsLoad>;
  allocate: (serviceId: string, slotId: string, workerId: string) => Promise<void>;
  actionError: ItineraryActionError | null;
  /** A ação chegou na API, mas o GET de refresh falhou — a aba mostra o itinerário de antes e avisa. */
  refreshError: boolean;
}

function isForbidden(err: unknown): boolean {
  return err instanceof ContractedServiceApiError && err.status === 403;
}

/**
 * Aba "Itinerario" (Fase 12, DX-12.6; molde `useServiceTeam`): 1 GET por montagem (a aba monta ao
 * abrir). `allocate` grava e, em sucesso E quando a API recusa com `code` (409/422), refaz 1 GET —
 * o card volta ao estado do banco. 403 → `forbidden`; erro sem `code` → `error` (sem refetch).
 *
 * Guarda ÚNICA por requisição (`requestIdRef`, a do `useServiceTeam`): GET da montagem e `allocate`
 * incrementam; só a resposta da requisição mais recente pinta. `loadOptions` não pinta estado do
 * hook — devolve o resultado ao modal que pediu — então não entra na guarda (abrir o modal durante
 * um refetch não descarta o refetch).
 */
export function usePatientItinerary(patientId: string): UsePatientItineraryResult {
  const [itinerary, setItinerary] = useState<PatientItinerary | null>(null);
  const [status, setStatus] = useState<PatientItineraryStatus>('idle');
  const [actionError, setActionError] = useState<ItineraryActionError | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setItinerary(null);
    setStatus('loading');
    setActionError(null);
    setRefreshError(false);
    AdminContractedServicesApiService.getItinerary(patientId)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setItinerary(result);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setStatus(isForbidden(err) ? 'forbidden' : 'error');
      });
  }, [patientId]);

  const loadOptions = useCallback(
    async (serviceId: string): Promise<AllocationOptionsLoad> => {
      try {
        const { options } = await AdminContractedServicesApiService.getAllocationOptions(patientId, serviceId);
        return { status: 'ok', options };
      } catch (err) {
        return { status: isForbidden(err) ? 'forbidden' : 'error' };
      }
    },
    [patientId],
  );

  const allocate = useCallback(
    async (serviceId: string, slotId: string, workerId: string) => {
      const requestId = ++requestIdRef.current;
      setActionError(null);
      setRefreshError(false);
      try {
        await AdminContractedServicesApiService.allocate(patientId, serviceId, slotId, workerId);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        if (isForbidden(err)) {
          setStatus('forbidden');
          return;
        }
        if (!(err instanceof ContractedServiceApiError && err.code)) {
          setStatus('error');
          return;
        }
        setActionError(err.overlap ? { code: err.code, overlap: err.overlap } : { code: err.code });
      }
      try {
        const result = await AdminContractedServicesApiService.getItinerary(patientId);
        if (requestIdRef.current !== requestId) return;
        setItinerary(result);
        setStatus('ok');
      } catch {
        // O refetch falhou depois de a API responder à ação: a aba segue com o itinerário atual
        // (nunca `error` — a tela sumiria por um refresh) e `refreshError` avisa que está velho.
        if (requestIdRef.current !== requestId) return;
        setRefreshError(true);
      }
    },
    [patientId],
  );

  return { itinerary, status, loadOptions, allocate, actionError, refreshError };
}
