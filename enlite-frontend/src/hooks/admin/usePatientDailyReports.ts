/**
 * usePatientDailyReports — lista dos informes da guarda da aba "Informes diarios" (spec 092, T501).
 * 1 GET por montagem (a aba monta ao abrir). 403 → `forbidden` (sem `daily_report:read`); qualquer outra falha → `error`.
 * Guarda `cancelled`: resposta de paciente anterior nunca pinta a tela do atual.
 */
import { useEffect, useState } from 'react';
import { AdminDailyReportsApiService, DailyReportsApiError } from '@infrastructure/http/AdminDailyReportsApiService';
import type { PatientDailyReport } from '@domain/entities/PatientDailyReport';

export type PatientDailyReportsStatus = 'loading' | 'ok' | 'forbidden' | 'error';

export function usePatientDailyReports(patientId: string): { reports: PatientDailyReport[]; status: PatientDailyReportsStatus } {
  const [reports, setReports] = useState<PatientDailyReport[]>([]);
  const [status, setStatus] = useState<PatientDailyReportsStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setReports([]);
    AdminDailyReportsApiService.listForPatient(patientId)
      .then((r) => {
        if (cancelled) return;
        setReports(r.items);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus(err instanceof DailyReportsApiError && err.status === 403 ? 'forbidden' : 'error');
      });
    return () => { cancelled = true; };
  }, [patientId]);

  return { reports, status };
}
