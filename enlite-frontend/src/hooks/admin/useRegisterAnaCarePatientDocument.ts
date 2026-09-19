import { useCallback, useRef, useState } from 'react';
import {
  AnaCarePatientDocumentServiceError,
  type AnaCarePatientDocumentService,
  type RegisterAnaCarePatientDocumentCommand,
  type RegisterAnaCarePatientDocumentResult,
} from '@presentation/components/features/admin/AnaCareHours/AnaCarePatientDocumentService';

export type RegisterPatientDocumentStatus = 'idle' | 'registering' | 'registrado' | 'error';

export interface UseRegisterAnaCarePatientDocumentResult {
  status: RegisterPatientDocumentStatus;
  result: RegisterAnaCarePatientDocumentResult | null;
  error: string | null;
  /** `error` LITERAL do corpo do backend (ex. "DocumentoJaRegistradoDivergenteError") — quem chama decide a mensagem por código, nunca mostra `error` (texto do backend) direto na tela. */
  errorCode: string | null;
  register: (command: RegisterAnaCarePatientDocumentCommand) => void;
}

/**
 * Fia o modal de documento (aberto quando `axonicoDayEligibility` acusa `missingDocument`) à rota
 * `POST /api/admin/integrations/anacare/patient-document`. MESMA trava de `useSendComprobanteToAxonico`
 * contra clique duplo — `inFlightRef` síncrono, verificado e marcado ANTES de qualquer `await`.
 */
export function useRegisterAnaCarePatientDocument(service: AnaCarePatientDocumentService): UseRegisterAnaCarePatientDocumentResult {
  const [status, setStatus] = useState<RegisterPatientDocumentStatus>('idle');
  const [result, setResult] = useState<RegisterAnaCarePatientDocumentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const register = useCallback(
    (command: RegisterAnaCarePatientDocumentCommand) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setStatus('registering');
      setError(null);
      setErrorCode(null);
      setResult(null);

      service
        .registerDocument(command)
        .then((res) => {
          setResult(res);
          setStatus('registrado');
        })
        .catch((err) => {
          const message = err instanceof AnaCarePatientDocumentServiceError || err instanceof Error ? err.message : 'No se pudo registrar el documento.';
          setError(message);
          setErrorCode(err instanceof AnaCarePatientDocumentServiceError ? err.code : null);
          setStatus('error');
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    },
    [service],
  );

  return { status, result, error, errorCode, register };
}
