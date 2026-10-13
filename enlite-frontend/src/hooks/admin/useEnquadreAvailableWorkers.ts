/**
 * useEnquadreAvailableWorkers — completados fora de evento aberto (spec 052). `count` é o contador do
 * cabeçalho da aba ("N completados sin evento"); `workers` alimenta o seletor do drawer. Falha = `error`.
 */
import { useCallback, useEffect, useState } from 'react';
import type { EnquadreWorkerOption } from '@domain/entities/EnquadreEvent';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import type { EnquadreLoadStatus } from './useEnquadreEvents';

export interface UseEnquadreAvailableWorkersResult {
  workers: EnquadreWorkerOption[];
  count: number;
  status: EnquadreLoadStatus;
  reload: () => Promise<void>;
}

export function useEnquadreAvailableWorkers(vacancyId: string): UseEnquadreAvailableWorkersResult {
  const [workers, setWorkers] = useState<EnquadreWorkerOption[]>([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<EnquadreLoadStatus>('loading');

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setStatus('loading');
    try {
      const out = await AdminEnquadreApiService.listAvailableWorkers(vacancyId);
      setWorkers(out.workers);
      setCount(out.count);
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [vacancyId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const reload = useCallback((): Promise<void> => load(true), [load]);

  return { workers, count, status, reload };
}
