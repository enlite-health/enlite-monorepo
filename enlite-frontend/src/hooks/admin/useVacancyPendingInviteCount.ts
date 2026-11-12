import { useCallback, useEffect, useState } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

/**
 * Contador do botão "Invitar prestadores" (089 T030, ⚑4): `pendingInVacancyCount` do
 * GET match-results `?limit=0` (só meta, sem candidatos). Falha de rede = 0 (sem bolinha): o botão
 * segue útil e a página de match tem o seu próprio estado de erro.
 */
export function useVacancyPendingInviteCount(vacancyId: string, enabled: boolean) {
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const meta = await AdminApiService.getMatchResults(vacancyId, 0);
      setCount(meta.pendingInVacancyCount ?? 0);
    } catch {
      setCount(0);
    }
  }, [vacancyId]);

  useEffect(() => {
    if (enabled) void refetch();
  }, [enabled, refetch]);

  return { count, refetch };
}
