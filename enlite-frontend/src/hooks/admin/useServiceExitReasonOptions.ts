import { useEffect, useState } from 'react';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import type { ServiceExitReasonOption } from '@domain/entities/TherapeuticProject';

export type ServiceExitReasonOptionsStatus = 'loading' | 'ok' | 'error';

export interface UseServiceExitReasonOptionsResult {
  options: ServiceExitReasonOption[];
  status: ServiceExitReasonOptionsStatus;
}

/**
 * Motivos de saída ATIVOS para quem registra uma troca: 1 GET por montagem do consumidor (o diálogo),
 * sem cache. O hook não filtra nem ordena — a lista vem pronta do backend (`options`, sob `patient_services:read`).
 */
export function useServiceExitReasonOptions(): UseServiceExitReasonOptionsResult {
  const [options, setOptions] = useState<ServiceExitReasonOption[]>([]);
  const [status, setStatus] = useState<ServiceExitReasonOptionsStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    AdminTherapeuticProjectsApiService.listServiceExitReasonOptions()
      .then((items) => {
        if (cancelled) return;
        setOptions(items);
        setStatus('ok');
      })
      .catch(() => {
        if (cancelled) return;
        setOptions([]);
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, []);

  return { options, status };
}
