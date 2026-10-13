/**
 * useEnquadreFreeSlots — horários livres da agenda do entrevistador num dia (spec 052, drawer de criar evento). Só
 * busca com entrevistador apto + data + duração válidos (senão `idle`). A lista vem pronta do servidor. Falha =
 * `error` (nunca lista vazia) e NÃO impede o operador de digitar a hora à mão.
 */
import { useEffect, useState } from 'react';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';

export type EnquadreFreeSlotsStatus = 'idle' | 'loading' | 'ok' | 'error';

export interface UseEnquadreFreeSlotsResult {
  slots: string[];
  status: EnquadreFreeSlotsStatus;
}

export function useEnquadreFreeSlots(
  vacancyId: string,
  hostId: string | null,
  date: string,
  durationMinutes: number,
): UseEnquadreFreeSlotsResult {
  const [slots, setSlots] = useState<string[]>([]);
  const [status, setStatus] = useState<EnquadreFreeSlotsStatus>('idle');
  const enabled = hostId !== null && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isInteger(durationMinutes) && durationMinutes > 0;

  useEffect(() => {
    if (!enabled || hostId === null) {
      setSlots([]);
      setStatus('idle');
      return undefined;
    }
    let stale = false;
    setStatus('loading');
    AdminEnquadreApiService.listHostFreeSlots(vacancyId, hostId, date, durationMinutes)
      .then((out) => { if (!stale) { setSlots(out); setStatus('ok'); } })
      .catch(() => { if (!stale) { setSlots([]); setStatus('error'); } });
    return () => { stale = true; };
  }, [enabled, vacancyId, hostId, date, durationMinutes]);

  return { slots, status };
}
