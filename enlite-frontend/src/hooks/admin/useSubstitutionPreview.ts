import { useEffect, useRef, useState } from 'react';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import type { SubstitutionPreview, SubstitutionPreviewBody } from '@domain/entities/SubstitutionRequest';
import { classifyActionError } from './contractedServiceActionError';

export type SubstitutionPreviewStatus = 'idle' | 'loading' | 'ok' | 'error';

export interface UseSubstitutionPreviewResult {
  status: SubstitutionPreviewStatus;
  preview: SubstitutionPreview | null;
  /** O `code` que a API explicou (422 `SUBSTITUTION_NO_SHIFTS_IN_PERIOD`, 409 …) — `null` em erro sem código. */
  errorCode: string | null;
}

/**
 * A pré-visão do pedido de substituição (spec 069, FR-15): turnos da pessoa no período, conflito TRI-ESTADO por candidato × turno
 * e o estado novo do paciente — tudo calculado no servidor, o hook só carrega. `body = null` = ainda não dá para perguntar
 * (`idle`). Refaz o POST quando o CORPO muda (comparado por valor); só a resposta da requisição mais recente pinta. Falha NUNCA
 * vira "sem conflito": a tela trata `error` como bloqueio.
 */
export function useSubstitutionPreview(patientId: string, serviceId: string, body: SubstitutionPreviewBody | null): UseSubstitutionPreviewResult {
  const [state, setState] = useState<UseSubstitutionPreviewResult>({ status: 'idle', preview: null, errorCode: null });
  const requestIdRef = useRef(0);
  const key = body === null ? null : JSON.stringify(body);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (key === null) {
      setState({ status: 'idle', preview: null, errorCode: null });
      return;
    }
    setState({ status: 'loading', preview: null, errorCode: null });
    AdminSubstitutionRequestsApiService.preview(patientId, serviceId, JSON.parse(key) as SubstitutionPreviewBody)
      .then((preview) => {
        if (requestIdRef.current === requestId) setState({ status: 'ok', preview, errorCode: null });
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        const classified = classifyActionError(err);
        setState({ status: 'error', preview: null, errorCode: classified.kind === 'coded' ? classified.code : null });
      });
  }, [patientId, serviceId, key]);

  return state;
}
