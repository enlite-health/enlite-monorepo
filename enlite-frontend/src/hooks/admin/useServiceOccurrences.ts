import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import { addDaysToDate } from '@presentation/components/features/admin/PatientDetail/substitutionDates';
import { isForbiddenError } from './contractedServiceActionError';

export type ServiceOccurrencesStatus = 'idle' | 'loading' | 'ok' | 'forbidden' | 'error';

export interface UseServiceOccurrencesResult {
  /** `null` enquanto carrega: a tabela nunca mostra turnos de OUTRA semana (FR-05). */
  events: PatientItineraryEvent[] | null;
  status: ServiceOccurrencesStatus;
  refresh: () => void;
}

/**
 * "Próximos días" (spec 069, FR-05): as ocorrências (faixa × data) de UM serviço na semana
 * `[weekStart, weekStart + 6]` — cada semana é uma janela de 7 dias, nunca perto do teto de 62 do
 * GET. Mesmo padrão de `usePatientItinerary`: guarda por `requestIdRef` (só a resposta da
 * requisição mais recente pinta), 403 → `forbidden`, erro sem código → `error`. O hook não calcula
 * nada: a expansão faixa × data e o "Sin cubrir" são do backend (`expandServiceOccurrences`).
 */
export function useServiceOccurrences(
  patientId: string,
  serviceId: string,
  weekStart: string,
  /** Muda quando uma escrita fora deste hook (alocar, quitar, pedido) invalida a semana: refaz o GET. */
  refreshKey = 0,
): UseServiceOccurrencesResult {
  const [events, setEvents] = useState<PatientItineraryEvent[] | null>(null);
  const [status, setStatus] = useState<ServiceOccurrencesStatus>('idle');
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setEvents(null);
    setStatus('loading');
    AdminContractedServicesApiService.getItineraryEvents(patientId, weekStart, addDaysToDate(weekStart, 6), { serviceId })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setEvents(result.events);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setStatus(isForbiddenError(err) ? 'forbidden' : 'error');
      });
  }, [patientId, serviceId, weekStart]);

  // `refreshKey` só invalida (uma escrita fora do hook): refaz o GET sem ser lido dentro de `load`.
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return { events, status, refresh: load };
}
