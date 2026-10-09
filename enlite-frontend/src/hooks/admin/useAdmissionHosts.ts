/**
 * useAdmissionHosts — o roster de admissão do país, com o estado do vínculo do Tactiq de cada responsável
 * (spec 049, F7). Só é pedido quando o modal "Nueva agenda" abre (`enabled`): a rota exige `patient_admission:create`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AdminAdmissionApiService,
  type AdmissionCountry,
  type AdmissionHost,
} from '@infrastructure/http/AdminAdmissionApiService';

export type AdmissionHostsStatus = 'idle' | 'loading' | 'ok' | 'error';

export function useAdmissionHosts(country: AdmissionCountry, enabled: boolean): {
  hosts: AdmissionHost[];
  status: AdmissionHostsStatus;
  retry: () => void;
} {
  const [hosts, setHosts] = useState<AdmissionHost[]>([]);
  const [status, setStatus] = useState<AdmissionHostsStatus>('idle');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setStatus('loading');
    AdminAdmissionApiService.listHosts(country)
      .then((list) => {
        if (cancelled) return;
        setHosts(list);
        setStatus('ok');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, [country, enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { hosts, status, retry };
}
