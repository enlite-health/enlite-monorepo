import { useState, useEffect, useCallback } from 'react';
import { AnaCareHoursServiceError, type AnaCareHoursMonthFilters, type AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareMonthSnapshot } from '@presentation/components/features/admin/AnaCareHours/types';

/**
 * Mesmo padrão de `usePatientsData` (useState/useEffect simples, sem react-query). O serviço
 * entra por INJEÇÃO — produção injeta `AnaCareHoursHttpService`, testes injetam
 * `FakeAnaCareHoursService`, sem mudar uma linha deste hook (mesmo contrato,
 * `AnaCareHoursService`). Portado de `repos/infra/_worktrees/proto-anacare-horas/.../hooks/admin/
 * useAnaCareHoursMonth.ts` sem mudança de comportamento, exceto o erro: quando o serviço lança
 * `AnaCareHoursServiceError` com `code === 'FONTE_NAO_CONFIGURADA'` (contrato HTTP: GET 503
 * `{code:'ANACARE_SOURCE_NOT_CONFIGURED'}`), `error` guarda o CÓDIGO, não a mensagem — o container
 * traduz o código para o texto i18n do banner de erro claro (brief: nunca tela branca).
 */
export function useAnaCareHoursMonth(service: AnaCareHoursService, month: string, filters?: AnaCareHoursMonthFilters) {
  const [snapshot, setSnapshot] = useState<AnaCareMonthSnapshot | null>(null);
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
        const result = await service.getMonthSnapshot(month, filters);
        if (!cancelled) setSnapshot(result);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof AnaCareHoursServiceError && err.code === 'FONTE_NAO_CONFIGURADA') {
          setError('FONTE_NAO_CONFIGURADA');
        } else {
          setError(err instanceof Error ? err.message : 'No se pudo cargar el mes.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, month, filters?.patientSearch, filters?.providerId, refreshKey]);

  return { snapshot, isLoading, error, refetch };
}
