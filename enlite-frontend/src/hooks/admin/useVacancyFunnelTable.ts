import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { FunnelBucket, FunnelTableData } from '@domain/entities/Funnel';
import type { VacancyFunnelColumn } from '@presentation/components/features/admin/VacancyDetail/Funnel/funnelTabsConfig';

const POLL_INTERVAL_MS = 10_000;

/**
 * O que o hook precisa de uma aba para montar a query (DX-2.1/DX-2.6): `key` identifica a aba
 * (dependência do fetch), e ou ela é uma coluna do Kanban (`columns=<sources>`) ou um bucket velho
 * (`bucket=<b>`). `FunnelTab` (funnelTabsConfig.ts) satisfaz esta forma estruturalmente — é o tipo
 * usado pelas abas de fato renderizadas (P17). `bucket` aqui aceita qualquer `FunnelBucket`
 * (não só os 3 que sobraram em `FunnelTab`), porque `useInvitedPendingCandidates` continua pedindo
 * `?bucket=INVITED` direto, sem estar entre as abas visíveis.
 */
export type FunnelTableTab =
  | { key: string; kind: 'column'; column: VacancyFunnelColumn }
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
    const intervalId = setInterval(() => fetchTable(true), POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [fetchTable, enabled]);

  return { data, isLoading, error, refetch: fetchTable };
}
