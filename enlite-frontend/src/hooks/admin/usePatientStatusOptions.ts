import { useCallback, useEffect, useState } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientStatusOption } from '@domain/entities/PatientDetail';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';

export type PatientStatusOptionsState =
  | { phase: 'loading' }
  | { phase: 'error' }
  /** 403 da lista: a conta não tem `patient:update` — a ficha fica só-leitura (estado atual), sem erro nem retry. */
  | { phase: 'readonly' }
  /** `forKey`: paciente + estado para o qual a lista foi calculada (lista de OUTRO estado não vale). */
  | { phase: 'ready'; options: PatientStatusOption[]; forKey: string };

/**
 * Spec 051 — a lista de destinos de estado que o SERVIDOR aceita para este paciente e este ator
 * (GET /patients/:id/status-options). Quem renderiza o select usa SÓ isto: a tela não decide FSM
 * nem permissão. Falha de leitura é estado próprio (`error`) — NUNCA vira "lista inteira": sem a
 * lista, o select fica travado e `reload` tenta de novo.
 *
 * `refreshKey` refaz a leitura quando o estado do paciente muda (o que era destino deixa de ser).
 * `enabled=false` não lê nada (ficha que ainda nem tem estado clínico).
 */
export function usePatientStatusOptions(patientId: string, refreshKey: unknown, enabled = true): {
  state: PatientStatusOptionsState;
  reload: () => void;
} {
  const [state, setState] = useState<PatientStatusOptionsState>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const key = `${patientId}|${String(refreshKey)}`;
    // Releitura por recusa (`reload`) mantém a lista que já havia — o select não fecha nem pisca. Mas lista de
    // OUTRO estado do paciente não vale: a 1ª leitura, o "tentar de novo" e a troca de estado travam até chegar a nova.
    setState((prev) => (prev.phase === 'ready' && prev.forKey === key ? prev : { phase: 'loading' }));
    AdminApiService.getPatientStatusOptions(patientId)
      .then((r) => { if (!cancelled) setState({ phase: 'ready', options: r.options, forKey: key }); })
      .catch((err: unknown) => {
        if (!cancelled) setState({ phase: err instanceof PatientApiError && err.status === 403 ? 'readonly' : 'error' });
      });
    return () => { cancelled = true; };
  }, [patientId, refreshKey, nonce, enabled]);

  return { state, reload };
}
