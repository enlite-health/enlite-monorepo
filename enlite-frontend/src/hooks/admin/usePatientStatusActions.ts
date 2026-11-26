import { useCallback, useEffect, useState } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientStatusActionOption } from '@domain/entities/PatientDetail';

export type PatientStatusActionsState =
  | { phase: 'loading' }
  | { phase: 'error' }
  /** 403 da lista: a conta não tem `patient:update` — sem ações, sem erro nem retry. */
  | { phase: 'readonly' }
  | { phase: 'ready'; actions: PatientStatusActionOption[]; forKey: string };

/**
 * F3 — as ações humanas sobre o estado (pausar, suspender, alta, baja, retomar, reativar) que o SERVIDOR aceita para este paciente e
 * este ator (GET /patients/:id/status-actions). A tela não decide FSM, permissão nem destino. Falha de leitura é estado próprio
 * (`error`): NUNCA vira "todas as ações". `refreshKey` refaz a leitura quando o estado/completude do paciente muda.
 */
export function usePatientStatusActions(patientId: string, refreshKey: unknown, enabled = true): {
  state: PatientStatusActionsState;
  reload: () => void;
} {
  const [state, setState] = useState<PatientStatusActionsState>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const key = `${patientId}|${String(refreshKey)}`;
    setState((prev) => (prev.phase === 'ready' && prev.forKey === key ? prev : { phase: 'loading' }));
    AdminApiService.getPatientStatusActions(patientId)
      .then((r) => { if (!cancelled) setState({ phase: 'ready', actions: r.actions, forKey: key }); })
      .catch((err: unknown) => {
        if (!cancelled) setState({ phase: err instanceof PatientApiError && err.status === 403 ? 'readonly' : 'error' });
      });
    return () => { cancelled = true; };
  }, [patientId, refreshKey, nonce, enabled]);

  return { state, reload };
}
