import { useEffect, useState } from 'react';
import { AdminPatientsApiService, PatientStats } from '@infrastructure/http/AdminPatientsApiService';

/**
 * Estado atual dos pacientes (total / completos / precisa atenção) para o
 * dashboard de Gestão à Vista. Busca só as métricas — sem carregar a lista,
 * ao contrário do `usePatientsData`, que é da tela de operação.
 *
 * `country` vazio = todos os países (o endpoint aceita AR|BR).
 */
export function usePatientStats(country: string) {
  const [stats, setStats] = useState<PatientStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);
        const data = await AdminPatientsApiService.getPatientStats({
          country: country || undefined,
        });
        if (!cancelled) setStats(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load stats');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [country]);

  return { stats, isLoading, error };
}
