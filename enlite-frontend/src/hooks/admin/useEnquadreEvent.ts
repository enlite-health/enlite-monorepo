/**
 * useEnquadreEvent — um evento com os participantes (o kanban do evento, spec 052). Falha = `error`, nunca vazio.
 */
import { useCallback, useEffect, useState } from 'react';
import type { EnquadreEventDetail } from '@domain/entities/EnquadreEvent';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import type { EnquadreLoadStatus } from './useEnquadreEvents';

export interface UseEnquadreEventResult {
  event: EnquadreEventDetail | null;
  status: EnquadreLoadStatus;
  reload: () => Promise<void>;
}

export function useEnquadreEvent(vacancyId: string, eventId: string): UseEnquadreEventResult {
  const [event, setEvent] = useState<EnquadreEventDetail | null>(null);
  const [status, setStatus] = useState<EnquadreLoadStatus>('loading');

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setStatus('loading');
    try {
      setEvent(await AdminEnquadreApiService.getEvent(vacancyId, eventId));
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [vacancyId, eventId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const reload = useCallback((): Promise<void> => load(true), [load]);

  return { event, status, reload };
}
