import { useState, useEffect, useCallback } from 'react';
import { AnaCareHoursServiceError, type AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareMonthSnapshot, AnaCarePatient, AnaCareRetratoStatus } from '@presentation/components/features/admin/AnaCareHours/types';

/**
 * Mesmo padrão de `usePatientsData`. Busca o paciente E o estado do retrato em paralelo
 * (`Promise.all`) e monta um `AnaCareMonthSnapshot` "de 1 paciente só" — a forma que
 * `AnaCareHoursDetailPage` já espera. Portado de `repos/infra/_worktrees/proto-anacare-horas/
 * .../hooks/admin/useAnaCareHoursPatient.ts` — mesma adaptação de erro 503 do irmão
 * `useAnaCareHoursMonth` (ver comentário lá).
 */
export function useAnaCareHoursPatient(service: AnaCareHoursService, month: string, patientId: string) {
  const [patient, setPatient] = useState<AnaCarePatient | null>(null);
  const [retrato, setRetrato] = useState<AnaCareRetratoStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function fetchData(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);
        const [patientResult, retratoResult] = await Promise.all([service.getPatientMonth(month, patientId), service.getRetratoStatus(month)]);
        if (!cancelled) {
          setPatient(patientResult);
          setRetrato(retratoResult);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof AnaCareHoursServiceError && err.code === 'FONTE_NAO_CONFIGURADA') {
          setError('FONTE_NAO_CONFIGURADA');
        } else {
          setError(err instanceof Error ? err.message : 'No se pudo cargar el paciente.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [service, month, patientId, refreshKey]);

  const snapshot: AnaCareMonthSnapshot | null = retrato
    ? {
        month,
        updatedAt: retrato.updatedAt,
        stale: retrato.stale,
        // Item 3 (conserto, 17/09): `AnaCareRetratoStatus` agora carrega `snapshotState` — não
        // aproxima mais. Antes disso, `stale ? 'velho' : 'fresco'` colapsava "nunca construído" em
        // "velho" e o detalhe mostrava "mais de 24 horas" quando o sync nunca rodou.
        snapshotState: retrato.snapshotState,
        circuitBreakerOpen: retrato.circuitBreakerOpen,
        patients: patient ? [patient] : [],
      }
    : null;

  return { patient, snapshot, isLoading, error, refetch };
}
