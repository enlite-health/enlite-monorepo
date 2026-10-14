/**
 * useEnquadreHosts — entrevistadores com o estado do vínculo (spec 052). Molde: useAdmissionHosts. Falha = `error`.
 */
import { useCallback, useEffect, useState } from 'react';
import type { EnquadreHostOption } from '@domain/entities/EnquadreEvent';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import type { EnquadreLoadStatus } from './useEnquadreEvents';

export interface UseEnquadreHostsResult {
  hosts: EnquadreHostOption[];
  status: EnquadreLoadStatus;
  reload: () => Promise<void>;
}

export function useEnquadreHosts(vacancyId: string): UseEnquadreHostsResult {
  const [hosts, setHosts] = useState<EnquadreHostOption[]>([]);
  const [status, setStatus] = useState<EnquadreLoadStatus>('loading');

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setStatus('loading');
    try {
      setHosts(await AdminEnquadreApiService.listHosts(vacancyId));
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [vacancyId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const reload = useCallback((): Promise<void> => load(true), [load]);

  return { hosts, status, reload };
}
