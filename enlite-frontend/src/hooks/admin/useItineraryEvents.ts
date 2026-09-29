import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import { isForbiddenError } from './contractedServiceActionError';

export type ItineraryEventsStatus = 'idle' | 'loading' | 'ok' | 'forbidden' | 'error';

export interface ItineraryEventsFilters {
  from: string;
  to: string;
  serviceId?: string;
  workerId?: string;
}

export interface UseItineraryEventsResult {
  events: PatientItineraryEvent[] | null;
  status: ItineraryEventsStatus;
  filters: ItineraryEventsFilters;
  setFilters: (filters: ItineraryEventsFilters) => void;
  refresh: () => void;
}

/**
 * "Próximos eventos/Substitución" (D445.3): 1 GET por montagem/troca de filtro, MESMO padrão de
 * `usePatientItinerary` (guarda por `requestIdRef`, 403 → `forbidden`, erro sem código → `error`).
 * O hook não calcula nada — a expansão faixa × data é 100% do backend (`expandItineraryEvents`).
 */
export function useItineraryEvents(patientId: string, initialFilters: ItineraryEventsFilters): UseItineraryEventsResult {
  const [filters, setFilters] = useState(initialFilters);
  const [events, setEvents] = useState<PatientItineraryEvent[] | null>(null);
  const [status, setStatus] = useState<ItineraryEventsStatus>('idle');
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setStatus('loading');
    AdminContractedServicesApiService.getItineraryEvents(patientId, filters.from, filters.to, {
      serviceId: filters.serviceId,
      workerId: filters.workerId,
    })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setEvents(result.events);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setStatus(isForbiddenError(err) ? 'forbidden' : 'error');
      });
  }, [patientId, filters.from, filters.to, filters.serviceId, filters.workerId]);

  useEffect(() => {
    load();
  }, [load]);

  return { events, status, filters, setFilters, refresh: load };
}
