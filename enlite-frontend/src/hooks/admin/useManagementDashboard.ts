import { useState, useEffect, useCallback, useRef } from 'react';
import { ManagementDashboardApiService } from '@infrastructure/http/ManagementDashboardApiService';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

/**
 * Intervalo de atualização. O Kanban (useWJAFunnel) usa 5s porque é uma vaga só;
 * aqui são 9 queries agregadas, então 30s — o bastante para a queixa real
 * ("deixei a aba aberta e o painel não atualiza") sem martelar o banco.
 */
const POLL_INTERVAL_MS = 30_000;

/** Períodos aceitos pelo backend (?funnelPeriodDays=). null = todo o histórico vivo. */
export type FunnelPeriodDays = 7 | 30 | 90 | null;

/** PR-9 (`lex` #9): '' = ALL (o rótulo "Todos" — resolvido no servidor como a união dos países do ator). */
export type ManagementCountryFilter = '' | 'AR' | 'BR';

interface UseManagementDashboardResult {
  data: ManagementDashboardData | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  /** Filtro por ENTRADA no funil por prestador (call 22/07). Muda → refetch imediato. */
  funnelPeriod: FunnelPeriodDays;
  setFunnelPeriod: (period: FunnelPeriodDays) => void;
  /** PR-9: filtro de país da página inteira (cabeçalho). '' = Todos (ALL). */
  country: ManagementCountryFilter;
  setCountry: (country: ManagementCountryFilter) => void;
}

export function useManagementDashboard(): UseManagementDashboardResult {
  const [data, setData] = useState<ManagementDashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [funnelPeriod, setFunnelPeriod] = useState<FunnelPeriodDays>(null);
  const [country, setCountry] = useState<ManagementCountryFilter>('');
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
      const result = await ManagementDashboardApiService.getManagementDashboard(
        funnelPeriod,
        country || null,
      );
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
  }, [funnelPeriod, country]);

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

  // Trocar o período refaz a busca imediatamente (fetchData depende de funnelPeriod,
  // então o useEffect acima re-executa e re-arma polling/visibilidade com o filtro novo).
  return { data, isLoading, error, refetch, funnelPeriod, setFunnelPeriod, country, setCountry };
}
