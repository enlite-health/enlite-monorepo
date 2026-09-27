import { useMemo } from 'react';
import { useVacancyFunnelTable } from './useVacancyFunnelTable';
import {
  funnelRowToInviteTarget,
  type InviteTarget,
} from '@presentation/components/features/admin/VacancyMatch/inviteTypes';

interface Result {
  candidates: InviteTarget[];
  pendingCount: number;
  isLoading: boolean;
  refetch: () => Promise<void> | void;
}

export function useInvitedPendingCandidates(vacancyId: string): Result {
  const { data, isLoading, refetch } = useVacancyFunnelTable(
    vacancyId,
    { key: 'INVITED', kind: 'bucket', bucket: 'INVITED' },
    true,
  );

  const candidates = useMemo<InviteTarget[]>(() => {
    if (!data?.rows) return [];
    return data.rows
      .filter(
        (r): r is typeof r & { workerId: string } =>
          r.whatsappStatus === 'NOT_SENT' && r.workerId !== null,
      )
      .map(funnelRowToInviteTarget);
  }, [data]);

  return {
    candidates,
    pendingCount: candidates.length,
    isLoading,
    refetch,
  };
}
