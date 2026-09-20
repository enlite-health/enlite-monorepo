/**
 * `useRegisterAnaCarePatientDocument` — MESMO padrão de `useSendComprobanteToAxonico.test.ts`,
 * inclusive a prova de clique duplo chamando `register()` duas vezes SEM esperar a primeira
 * Promise resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRegisterAnaCarePatientDocument } from './useRegisterAnaCarePatientDocument';
import {
  AnaCarePatientDocumentServiceError,
  type AnaCarePatientDocumentService,
  type RegisterAnaCarePatientDocumentCommand,
  type RegisterAnaCarePatientDocumentResult,
} from '@presentation/components/features/admin/AnaCareHours/AnaCarePatientDocumentService';

const COMMAND: RegisterAnaCarePatientDocumentCommand = { anaCarePatientId: 'ac-paciente-1', documentNumber: '30111222' };

const RECORD: RegisterAnaCarePatientDocumentResult['record'] = {
  id: 'doc-1',
  anaCarePatientId: 'ac-paciente-1',
  documentNumber: '30111222',
  documentType: 'DNI',
  registeredBy: 'uid-staff-1',
  createdAt: '2026-09-19T00:00:00Z',
  updatedAt: '2026-09-19T00:00:00Z',
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useRegisterAnaCarePatientDocument', () => {
  let service: AnaCarePatientDocumentService;
  let registerDocument: ReturnType<
    typeof vi.fn<[RegisterAnaCarePatientDocumentCommand], Promise<RegisterAnaCarePatientDocumentResult>>
  >;

  beforeEach(() => {
    registerDocument = vi.fn();
    service = { registerDocument };
  });

  it('POSITIVO — nasce idle, sem resultado nem erro', () => {
    const { result } = renderHook(() => useRegisterAnaCarePatientDocument(service));
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
  });

  it('POSITIVO — register() vai para "registering" e depois "registrado", com o resultado', async () => {
    const { promise, resolve } = deferred<RegisterAnaCarePatientDocumentResult>();
    registerDocument.mockReturnValue(promise);
    const { result } = renderHook(() => useRegisterAnaCarePatientDocument(service));

    act(() => result.current.register(COMMAND));
    expect(result.current.status).toBe('registering');

    await act(async () => {
      resolve({ status: 'registrado', record: RECORD });
      await promise;
    });

    await waitFor(() => expect(result.current.status).toBe('registrado'));
    expect(result.current.result).toEqual({ status: 'registrado', record: RECORD });
    expect(result.current.error).toBeNull();
  });

  it('POSITIVO — resposta "ja_registrado" (idempotente) também vai para "registrado" no status do hook', async () => {
    registerDocument.mockResolvedValue({ status: 'ja_registrado', record: RECORD });
    const { result } = renderHook(() => useRegisterAnaCarePatientDocument(service));

    await act(async () => result.current.register(COMMAND));

    await waitFor(() => expect(result.current.status).toBe('registrado'));
    expect(result.current.result?.status).toBe('ja_registrado');
  });

  it('NEGATIVO — 409 (documento já registrado com número diferente) vai para status "error" com o código do backend', async () => {
    registerDocument.mockRejectedValueOnce(
      new AnaCarePatientDocumentServiceError('DocumentoJaRegistradoDivergenteError', 'Ya existe un documento distinto registrado.'),
    );
    const { result } = renderHook(() => useRegisterAnaCarePatientDocument(service));

    await act(async () => result.current.register(COMMAND));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorCode).toBe('DocumentoJaRegistradoDivergenteError');
    expect(result.current.error).toBe('Ya existe un documento distinto registrado.');
  });

  it('NEGATIVO — documento inválido (422) vai para status "error" com código DISTINTO do 409', async () => {
    registerDocument.mockRejectedValueOnce(new AnaCarePatientDocumentServiceError('DocumentoInvalidoError', 'Documento inválido.'));
    const { result } = renderHook(() => useRegisterAnaCarePatientDocument(service));

    await act(async () => result.current.register(COMMAND));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorCode).toBe('DocumentoInvalidoError');
    expect(result.current.errorCode).not.toBe('DocumentoJaRegistradoDivergenteError');
  });

  it('NEGATIVO — erro não reconhecido (nem AnaCarePatientDocumentServiceError nem Error) cai no fallback genérico, sem código', async () => {
    registerDocument.mockRejectedValueOnce('boom');
    const { result } = renderHook(() => useRegisterAnaCarePatientDocument(service));

    await act(async () => result.current.register(COMMAND));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('No se pudo registrar el documento.');
    expect(result.current.errorCode).toBeNull();
  });

  it('POSITIVO — duas chamadas de register() de volta a volta, ANTES da primeira Promise resolver, resultam em UMA SÓ chamada ao serviço', async () => {
    const { promise, resolve } = deferred<RegisterAnaCarePatientDocumentResult>();
    registerDocument.mockReturnValue(promise);
    const { result } = renderHook(() => useRegisterAnaCarePatientDocument(service));

    act(() => {
      result.current.register(COMMAND);
      result.current.register(COMMAND); // segunda chamada, síncrona, ANTES de qualquer await.
    });

    expect(registerDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ status: 'registrado', record: RECORD });
      await promise;
    });
    await waitFor(() => expect(result.current.status).toBe('registrado'));
    expect(registerDocument).toHaveBeenCalledTimes(1);
  });

  it('POSITIVO — depois que a primeira corrida termina, um NOVO register() é aceito normalmente (a trava é só ENQUANTO em voo)', async () => {
    registerDocument.mockRejectedValueOnce(new AnaCarePatientDocumentServiceError('DocumentoInvalidoError', 'Documento inválido.'));
    const { result } = renderHook(() => useRegisterAnaCarePatientDocument(service));

    await act(async () => result.current.register(COMMAND));
    await waitFor(() => expect(result.current.status).toBe('error'));

    registerDocument.mockResolvedValueOnce({ status: 'registrado', record: RECORD });
    await act(async () => result.current.register(COMMAND));
    await waitFor(() => expect(result.current.status).toBe('registrado'));
    expect(registerDocument).toHaveBeenCalledTimes(2);
  });
});
