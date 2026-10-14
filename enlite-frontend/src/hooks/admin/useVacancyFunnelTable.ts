import { useState, useEffect, useCallback, useRef } from 'react';
import { startVisiblePolling } from './visiblePolling';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { FunnelBucket, FunnelTableData } from '@domain/entities/Funnel';
import type { VacancyFunnelColumn } from '@presentation/components/features/admin/VacancyDetail/Funnel/funnelTabsConfig';

const POLL_INTERVAL_MS = 10_000;

/**
 * O que o hook precisa para montar a query: `key` identifica a consulta (dependência do fetch), e ou
 * é um conjunto de colunas do Kanban (`columns=<sources>`; só as `sources` importam) ou um bucket
 * (`bucket=<b>`). A Lista da vaga pede todas as colunas do Kanban de uma vez; `bucket` segue aceito
 * porque `useInvitedPendingCandidates` pede `?bucket=INVITED` direto.
 */
export type FunnelTableTab =
  | { key: string; kind: 'column'; column: Pick<VacancyFunnelColumn, 'sources'> }
  | { key: string; kind: 'bucket'; bucket: FunnelBucket };

export function useVacancyFunnelTable(
  vacancyId: string | undefined,
  tab: FunnelTableTab,
  enabled: boolean,
) {
  const [data, setData] = useState<FunnelTableData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchTable = useCallback(
    async (silent = false) => {
      if (!vacancyId || !enabled || isFetchingRef.current) return;
      isFetchingRef.current = true;
      try {
        if (!silent) {
          setIsLoading(true);
          setError(null);
        }
        const response = await AdminApiService.getVacancyFunnelTable(
          vacancyId,
          tab.kind === 'column' ? { columns: tab.column.sources } : { bucket: tab.bucket },
        );
        setData(response);
        if (!silent) setError(null);
      } catch (err) {
        if (!silent)
          setError(
            err instanceof Error ? err.message : 'Failed to load funnel table',
          );
      } finally {
        if (!silent) setIsLoading(false);
        isFetchingRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tab.key identifica a aba; o objeto tab é recriado a cada render pelo chamador
    [vacancyId, tab.key, enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    fetchTable();
    return startVisiblePolling(() => void fetchTable(true), POLL_INTERVAL_MS);
  }, [fetchTable, enabled]);

  return { data, isLoading, error, refetch: fetchTable };
}
