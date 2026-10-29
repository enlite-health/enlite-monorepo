import { useEffect, useState } from 'react';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import type { ShiftTemplate } from '@domain/entities/TherapeuticProject';

export type ServiceShiftTemplateOptionsStatus = 'loading' | 'ok' | 'error';

export interface UseServiceShiftTemplateOptionsResult {
  options: ShiftTemplate[];
  status: ServiceShiftTemplateOptionsStatus;
}

/**
 * Guardias predefinidas ATIVAS (com os turnos) para quem carrega um serviço: 1 GET por montagem do consumidor,
 * sem cache. O hook não filtra nem ordena — a lista vem pronta do backend (`options`, sob `patient_services:read`).
 */
export function useServiceShiftTemplateOptions(): UseServiceShiftTemplateOptionsResult {
  const [options, setOptions] = useState<ShiftTemplate[]>([]);
  const [status, setStatus] = useState<ServiceShiftTemplateOptionsStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    AdminTherapeuticProjectsApiService.listShiftTemplateOptions()
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
