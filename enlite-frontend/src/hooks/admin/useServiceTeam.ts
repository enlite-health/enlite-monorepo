import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { ServiceTeam } from '@domain/entities/ServiceTeam';

export type ServiceTeamStatus = 'idle' | 'loading' | 'ok' | 'forbidden' | 'error';

export interface UseServiceTeamResult {
  team: ServiceTeam | null;
  status: ServiceTeamStatus;
  reject: (workerId: string, reasonCategory?: string) => Promise<void>;
  revert: (workerId: string, reasonCategory?: string) => Promise<void>;
  actionError: string | null;
}

/**
 * Quadro C (DX-10.8): 1 GET por seleção de linha. `selectionNonce` muda a cada clique — inclusive
 * re-clicar a MESMA linha, que é como o operador "atualiza" C sem recarregar a página (critérios 2
 * e 15). `reject`/`revert` gravam a marca e recebem o time já recalculado na resposta — nunca um
 * refetch depois da ação (0 GET extra). Resposta atrasada de uma seleção anterior é descartada
 * pelo `serviceId` CORRENTE (`currentServiceIdRef`) — trocar de linha rápido não pinta o time
 * errado.
 */
export function useServiceTeam(
  patientId: string,
  serviceId: string | null,
  selectionNonce: number,
): UseServiceTeamResult {
  const [team, setTeam] = useState<ServiceTeam | null>(null);
  const [status, setStatus] = useState<ServiceTeamStatus>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const currentServiceIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!serviceId) {
      currentServiceIdRef.current = null;
      setTeam(null);
      setStatus('idle');
      setActionError(null);
      return;
    }
    currentServiceIdRef.current = serviceId;
    setTeam(null);
    setStatus('loading');
    setActionError(null);
    AdminContractedServicesApiService.getServiceTeam(patientId, serviceId)
      .then((result) => {
        if (currentServiceIdRef.current !== serviceId) return; // resposta atrasada de outra linha
        setTeam(result);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (currentServiceIdRef.current !== serviceId) return;
        setStatus(err instanceof ContractedServiceApiError && err.status === 403 ? 'forbidden' : 'error');
      });
  }, [patientId, serviceId, selectionNonce]);

  /** `reject`/`revert` compartilham a régua de erro (403 → forbidden; 422/409 → actionError = code; outro → error). */
  const runAction = useCallback(
    async (call: (sid: string) => Promise<ServiceTeam>) => {
      if (!serviceId) return;
      const targetServiceId = serviceId;
      setActionError(null);
      try {
        const result = await call(targetServiceId);
        if (currentServiceIdRef.current !== targetServiceId) return; // trocou de linha durante a ação
        setTeam(result);
        setStatus('ok');
      } catch (err) {
        if (currentServiceIdRef.current !== targetServiceId) return;
        if (err instanceof ContractedServiceApiError && err.status === 403) {
          setStatus('forbidden');
          return;
        }
        if (err instanceof ContractedServiceApiError && err.code) {
          setActionError(err.code);
          return;
        }
        setStatus('error');
      }
    },
    [serviceId],
  );

  const reject = useCallback(
    (workerId: string, reasonCategory?: string) =>
      runAction((sid) => AdminContractedServicesApiService.rejectServiceTeamMember(patientId, sid, workerId, reasonCategory)),
    [patientId, runAction],
  );

  const revert = useCallback(
    (workerId: string, reasonCategory?: string) =>
      runAction((sid) => AdminContractedServicesApiService.revertServiceTeamMember(patientId, sid, workerId, reasonCategory)),
    [patientId, runAction],
  );

  return { team, status, reject, revert, actionError };
}
