import { useCallback, useRef, useState } from 'react';
import {
  AxonicoComprobanteServiceError,
  type AxonicoComprobanteService,
  type EnviarComprobanteAxonicoCommand,
  type EnviarComprobanteAxonicoResult,
} from '@presentation/components/features/admin/AnaCareHours/AxonicoComprobanteService';

export type SendComprobanteStatus = 'idle' | 'sending' | 'enviado' | 'duplicado' | 'error';

export interface UseSendComprobanteToAxonicoResult {
  status: SendComprobanteStatus;
  result: EnviarComprobanteAxonicoResult | null;
  error: string | null;
  send: (command: EnviarComprobanteAxonicoCommand) => void;
}

/**
 * Fia o clique do botão "Enviar" de UM dia à rota do Axonico. Cada clique fatura dinheiro de
 * verdade (regra dura do brief) — a trava contra disparo duplo é o `useRef` (`inFlightRef`),
 * verificado e marcado de forma SÍNCRONA, ANTES de qualquer `await`; duas chamadas de `send()`
 * feitas de volta a volta, sem esperar a primeira Promise resolver, resultam em UMA chamada só ao
 * serviço (a segunda é descartada em silêncio, ainda em `idle`/`sending` da primeira). Isso é
 * independente do `disabled`/`isLoading` do átomo `Button` (que só bloqueia o evento de clique DO
 * DOM depois que o React já comitou o novo estado) — a proteção real está aqui, não lá.
 */
export function useSendComprobanteToAxonico(service: AxonicoComprobanteService): UseSendComprobanteToAxonicoResult {
  const [status, setStatus] = useState<SendComprobanteStatus>('idle');
  const [result, setResult] = useState<EnviarComprobanteAxonicoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const send = useCallback(
    (command: EnviarComprobanteAxonicoCommand) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setStatus('sending');
      setError(null);
      setResult(null);

      service
        .enviarComprobante(command)
        .then((res) => {
          setResult(res);
          setStatus(res.status === 'duplicado' ? 'duplicado' : 'enviado');
        })
        .catch((err) => {
          const message = err instanceof AxonicoComprobanteServiceError || err instanceof Error ? err.message : 'No se pudo enviar la prestación.';
          setError(message);
          setStatus('error');
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    },
    [service],
  );

  return { status, result, error, send };
}
