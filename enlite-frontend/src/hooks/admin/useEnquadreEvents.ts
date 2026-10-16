/**
 * useEnquadreEvents — a lista de eventos da aba Enquadre (spec 052). UMA fonte: o GET. Mutação termina em
 * `reload()`. Falha da carga vira `status: 'error'` (nunca lista vazia). Molde: useAdmissionAppointments.
 */
import { useCallback, useEffect, useState } from 'react';
import type { EnquadreEventListItem } from '@domain/entities/EnquadreEvent';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';

export type EnquadreLoadStatus = 'loading' | 'ok' | 'error';

export interface UseEnquadreEventsResult {
  events: EnquadreEventListItem[];
  status: EnquadreLoadStatus;
  reload: () => Promise<void>;
}

export function useEnquadreEvents(vacancyId: string): UseEnquadreEventsResult {
  const [events, setEvents] = useState<EnquadreEventListItem[]>([]);
  const [status, setStatus] = useState<EnquadreLoadStatus>('loading');

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setStatus('loading');
    try {
      setEvents(await AdminEnquadreApiService.listEvents(vacancyId));
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [vacancyId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const reload = useCallback((): Promise<void> => load(true), [load]);

  return { events, status, reload };
}
