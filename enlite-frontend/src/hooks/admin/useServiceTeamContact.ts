import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { ServiceTeamContact, RegisterServiceTeamContactBody } from '@domain/entities/ServiceTeam';

export type ServiceTeamContactStatus = 'loading' | 'ok' | 'forbidden' | 'error';

export interface UseServiceTeamContactResult {
  contact: ServiceTeamContact | null;
  status: ServiceTeamContactStatus;
  register: (body: RegisterServiceTeamContactBody) => Promise<void>;
  saving: boolean;
  saveError: string | null;
}

/**
 * Modal do prestador (quadro C, rodada 2, decisão D): 1 GET ao abrir (por `patientId`/`serviceId`/
 * `workerId`), `register` grava e recebe o histórico já recalculado — 0 GET extra, molde
 * `useServiceTeam.ts`. Guarda por REQUISIÇÃO (mesmo padrão do irmão): um `workerId` novo ou um
 * `register` em voo invalidam a resposta anterior que chegar atrasada.
 */
export function useServiceTeamContact(
  patientId: string,
  serviceId: string | null,
  workerId: string | null,
): UseServiceTeamContactResult {
  const [contact, setContact] = useState<ServiceTeamContact | null>(null);
  const [status, setStatus] = useState<ServiceTeamContactStatus>('loading');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!serviceId || !workerId) {
      requestIdRef.current += 1;
      setContact(null);
      setStatus('loading');
      setSaveError(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    setStatus('loading');
    setSaveError(null);
    AdminContractedServicesApiService.getServiceTeamContact(patientId, serviceId, workerId)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setContact(result);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setStatus(err instanceof ContractedServiceApiError && err.status === 403 ? 'forbidden' : 'error');
      });
  }, [patientId, serviceId, workerId]);

  const register = useCallback(
    async (body: RegisterServiceTeamContactBody) => {
      if (!serviceId || !workerId) return;
      const requestId = ++requestIdRef.current;
      setSaving(true);
      setSaveError(null);
      try {
        const result = await AdminContractedServicesApiService.registerServiceTeamContact(patientId, serviceId, workerId, body);
        if (requestIdRef.current !== requestId) return;
        setContact(result);
        setStatus('ok');
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setSaveError(err instanceof ContractedServiceApiError ? (err.code ?? 'generic') : 'generic');
      } finally {
        if (requestIdRef.current === requestId) setSaving(false);
      }
    },
    [patientId, serviceId, workerId],
  );

  return { contact, status, register, saving, saveError };
}
