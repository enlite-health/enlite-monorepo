import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { ServiceTeam } from '@domain/entities/ServiceTeam';
import { classifyActionError } from './contractedServiceActionError';

export type ServiceTeamStatus = 'idle' | 'loading' | 'ok' | 'forbidden' | 'error';

export interface UseServiceTeamResult {
  team: ServiceTeam | null;
  status: ServiceTeamStatus;
  reject: (workerId: string, reasonCategory?: string) => Promise<void>;
  revert: (workerId: string, reasonCategory?: string) => Promise<void>;
  substitute: (allocationId: string, date: string, substituteWorkerId: string | null, reasonCategory: string) => Promise<void>;
  actionError: string | null;
  /** N3 do gate fecho: a ação gravou, mas o GET de refresh falhou — o quadro mostra o time de antes
   * e a seção avisa ("recargá la página"). Zera a cada requisição nova (GET ou ação). */
  refreshError: boolean;
}

type ApplyErrorSetters = {
  setStatus: (s: ServiceTeamStatus) => void;
  setActionError: (code: string | null) => void;
};

/** Erro das ações do quadro C (N4 do gate fecho — `reject`/`revert` e o POST do `substitute`) pela
 * régua ÚNICA `classifyActionError`: 403 → forbidden; código conhecido (422/409) → `actionError` =
 * code; resto → error. */
function applyActionError(err: unknown, { setStatus, setActionError }: ApplyErrorSetters): void {
  const classified = classifyActionError(err);
  if (classified.kind === 'coded') setActionError(classified.code);
  else setStatus(classified.kind);
}

/**
 * Quadro C (DX-10.8): 1 GET por seleção de linha. `selectionNonce` muda a cada clique — inclusive
 * re-clicar a MESMA linha, que é como o operador "atualiza" C sem recarregar a página (critérios 2
 * e 15). `reject`/`revert` gravam a marca e recebem o time já recalculado na resposta — nunca um
 * refetch depois da ação (0 GET extra).
 *
 * Guarda por REQUISIÇÃO (gate parcial #8, achado C3 do veredito; estendida ao N3 do gate fecho):
 * `requestIdRef` incrementa a CADA requisição — GET (troca de linha OU re-clique da mesma linha)
 * OU ação (`reject`/`revert`) — e só a resposta cuja requisição é a mais recente pinta o estado.
 * Guardar só pelo `serviceId` (como antes, e como as ações faziam até o N3) não distingue duas
 * requisições do MESMO serviço — um re-clique rápido cuja 1ª resposta chega DEPOIS da 2ª (seja
 * GET×GET, seja ação×GET) sobrescreveria o estado com o dado velho, porque o `serviceId` das duas
 * é igual.
 */
export function useServiceTeam(
  patientId: string,
  serviceId: string | null,
  selectionNonce: number,
): UseServiceTeamResult {
  const [team, setTeam] = useState<ServiceTeam | null>(null);
  const [status, setStatus] = useState<ServiceTeamStatus>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!serviceId) {
      requestIdRef.current += 1;
      setTeam(null);
      setStatus('idle');
      setActionError(null);
      setRefreshError(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setTeam(null);
    setStatus('loading');
    setActionError(null);
    setRefreshError(false);
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

  /** `reject`/`revert` compartilham a régua de erro (403 → forbidden; 422/409 → actionError = code;
   * outro → error) e a MESMA guarda de requisição do GET (`requestIdRef`, N3 do gate fecho): a
   * resposta de uma ação só pinta o estado se nenhuma requisição mais nova — GET ou outra ação —
   * começou depois dela. */
  const runAction = useCallback(
    async (call: (sid: string) => Promise<ServiceTeam>) => {
      if (!serviceId) return;
      const targetServiceId = serviceId;
      const requestId = ++requestIdRef.current;
      setActionError(null);
      setRefreshError(false);
      try {
        const result = await call(targetServiceId);
        if (requestIdRef.current !== requestId) return; // requisição mais nova (GET ou ação) já começou
        setTeam(result);
        setStatus('ok');
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        applyActionError(err, { setStatus, setActionError });
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

  /**
   * "Sustituir un día" (DX-13.11/13.13): registra a ausência e, em sucesso, refaz 1 GET do time
   * (a resposta do POST não traz o time — `reject`/`revert` seguem com 0 GET extra, só esta ação
   * tem o GET a mais). `substituteWorkerId: null` = "Sin reemplazo" (Q-S1) — a chave sai OMITIDA
   * do corpo do registro (dia fica como alerta; ausente ≠ o `null` explícito do PATCH substitute).
   *
   * Achado C3 (veredito parcial-1): o GET de refresh é tratado À PARTE do POST — a ausência já foi
   * gravada quando ele roda, então uma falha SÓ dele não pode derrubar o quadro inteiro (`runAction`
   * trataria qualquer erro do `call()` como erro geral e zeraria `status`). POST com erro segue a
   * MESMA régua de `reject`/`revert` (`applyActionError`); GET com erro NÃO mexe em `team`/`status`
   * — o quadro fica com o dado de antes da escrita e `refreshError` fica `true`.
   */
  const substitute = useCallback(
    async (allocationId: string, date: string, substituteWorkerId: string | null, reasonCategory: string) => {
      if (!serviceId) return;
      const targetServiceId = serviceId;
      const requestId = ++requestIdRef.current;
      setActionError(null);
      setRefreshError(false);
      try {
        await AdminContractedServicesApiService.registerAbsence(patientId, targetServiceId, allocationId, {
          date,
          ...(substituteWorkerId ? { substituteWorkerId } : {}),
          reasonCategory,
        });
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        applyActionError(err, { setStatus, setActionError });
        return;
      }
      try {
        const result = await AdminContractedServicesApiService.getServiceTeam(patientId, targetServiceId);
        if (requestIdRef.current !== requestId) return;
        setTeam(result);
        setStatus('ok');
      } catch {
        // GET de refresh falhou depois de um POST que já teve sucesso (C3): o quadro segue com o
        // time atual — nunca `setStatus('error')` aqui, senão o board some por um refresh que falhou.
        // N3 do gate fecho: não é silêncio — `refreshError` avisa que a gravação valeu e o quadro
        // está velho (o operador recarrega em vez de repetir e tomar 409).
        if (requestIdRef.current !== requestId) return;
        setRefreshError(true);
      }
    },
    [patientId, serviceId],
  );

  return { team, status, reject, revert, substitute, actionError, refreshError };
}
