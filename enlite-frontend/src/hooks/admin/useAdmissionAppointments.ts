/**
 * useAdmissionAppointments — a lista da aba Admissão (spec 049, F7). UMA fonte: o GET. Qualquer mutação
 * (agendar, cancelar, reenviar) termina em `reload()`, porque os selos dependem da mensageria no servidor e a
 * tela não os recalcula. Falha da carga vira `status: 'error'` (nunca lista vazia).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AdminAdmissionApiService,
  type AdmissionAppointment,
} from '@infrastructure/http/AdminAdmissionApiService';

export type AdmissionAppointmentsStatus = 'loading' | 'ok' | 'error';

export interface UseAdmissionAppointmentsResult {
  appointments: AdmissionAppointment[];
  status: AdmissionAppointmentsStatus;
  reload: () => Promise<void>;
}

export function useAdmissionAppointments(patientId: string): UseAdmissionAppointmentsResult {
  const [appointments, setAppointments] = useState<AdmissionAppointment[]>([]);
  const [status, setStatus] = useState<AdmissionAppointmentsStatus>('loading');

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setStatus('loading');
    try {
      setAppointments(await AdminAdmissionApiService.listAppointments(patientId));
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [patientId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const reload = useCallback((): Promise<void> => load(true), [load]);

  return { appointments, status, reload };
}
