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
 * refetch depois da ação (0 GET extra).
 *
 * Guarda por REQUISIÇÃO (gate parcial #8, achado C3 do veredito): `requestIdRef` incrementa a CADA
 * fetch (troca de linha OU re-clique da mesma linha) e só a resposta cuja requisição é a mais
 * recente pinta o estado. Guardar só pelo `serviceId` (como antes) não distingue duas requisições
 * do MESMO serviço — um re-clique rápido cuja 1ª resposta chega DEPOIS da 2ª sobrescreveria o
 * estado com o dado velho, porque o `serviceId` das duas é igual.
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
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!serviceId) {
      requestIdRef.current += 1;
      currentServiceIdRef.current = null;
      setTeam(null);
      setStatus('idle');
      setActionError(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    currentServiceIdRef.current = serviceId;
    setTeam(null);
    setStatus('loading');
    setActionError(null);
    AdminContractedServicesApiService.getServiceTeam(patientId, serviceId)
      .then((result) => {
        if (requestIdRef.current !== requestId) return; // resposta de uma requisição anterior (mesma linha ou outra)
        setTeam(result);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
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
