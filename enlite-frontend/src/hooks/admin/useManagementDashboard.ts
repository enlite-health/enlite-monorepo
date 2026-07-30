import { useState, useEffect, useCallback, useRef } from 'react';
import { ManagementDashboardApiService } from '@infrastructure/http/ManagementDashboardApiService';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

/**
 * Intervalo de atualização. O Kanban (useWJAFunnel) usa 5s porque é uma vaga só;
 * aqui são 9 queries agregadas, então 30s — o bastante para a queixa real
 * ("deixei a aba aberta e o painel não atualiza") sem martelar o banco.
 */
const POLL_INTERVAL_MS = 30_000;

interface UseManagementDashboardResult {
  data: ManagementDashboardData | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useManagementDashboard(): UseManagementDashboardResult {
  const [data, setData] = useState<ManagementDashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Guarda de concorrência: nunca duas buscas em voo (padrão do useWJAFunnel). */
  const isFetchingRef = useRef(false);

  /**
   * `silent` = atualização de fundo: não acende o skeleton nem apaga a tela em
   * caso de falha de rede momentânea. Sem isso o polling faria a tela piscar.
   */
  const fetchData = useCallback(async (silent = false) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      const result = await ManagementDashboardApiService.getManagementDashboard();
      setData(result);
      if (!silent) setError(null);
    } catch (err: unknown) {
      if (!silent) {
        setError(err instanceof Error ? err.message : 'Failed to fetch management dashboard');
      }
    } finally {
      if (!silent) setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  const refetch = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    void fetchData();

    const intervalId = setInterval(() => void fetchData(true), POLL_INTERVAL_MS);

    // Voltar para a aba busca na hora: é o caso real de quem deixa o painel aberto
    // e volta depois de mover cards no Kanban.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void fetchData(true);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchData]);

  return { data, isLoading, error, refetch };
}
