/**
 * `useSendComprobanteToAxonico` — laço de estado do botão "Enviar" de UM dia. A prova de clique
 * duplo AQUI (chamando `send()` duas vezes SEM esperar a primeira Promise resolver) é a que
 * conta de verdade: um teste no NÍVEL DO BOTÃO ("clicar duas vezes") corre o risco medido no
 * brief — `Button.tsx:46` já é `disabled={disabled || isLoading}`, e depois do primeiro clique
 * `isLoading` vira `true` e o segundo clique nem chega a disparar o evento no DOM (nativo, jsdom
 * inclusive) — o teste passaria mesmo SEM nenhuma trava própria. Testando o `send()` do hook
 * direto, duas vezes de volta a volta, a passagem só é possível se o `inFlightRef` interno
 * realmente existir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSendComprobanteToAxonico } from './useSendComprobanteToAxonico';
import {
  AxonicoComprobanteServiceError,
  type AxonicoComprobanteService,
  type EnviarComprobanteAxonicoCommand,
  type EnviarComprobanteAxonicoResult,
} from '@presentation/components/features/admin/AnaCareHours/AxonicoComprobanteService';

const COMMAND: EnviarComprobanteAxonicoCommand = { documentNumber: '30111222', serviceDate: '2026-08-14', hours: 8 };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useSendComprobanteToAxonico', () => {
  let service: AxonicoComprobanteService;
  let enviarComprobante: ReturnType<typeof vi.fn<[EnviarComprobanteAxonicoCommand], Promise<EnviarComprobanteAxonicoResult>>>;

  beforeEach(() => {
    enviarComprobante = vi.fn();
    service = { enviarComprobante };
  });

  it('POSITIVO — nasce idle, sem resultado nem erro', () => {
    const { result } = renderHook(() => useSendComprobanteToAxonico(service));
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('POSITIVO — send() vai para "sending" e depois "enviado", com o resultado', async () => {
    const { promise, resolve } = deferred<EnviarComprobanteAxonicoResult>();
    enviarComprobante.mockReturnValue(promise);
    const { result } = renderHook(() => useSendComprobanteToAxonico(service));

    act(() => result.current.send(COMMAND));
    expect(result.current.status).toBe('sending');

    await act(async () => {
      resolve({ status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' });
      await promise;
    });

    await waitFor(() => expect(result.current.status).toBe('enviado'));
    expect(result.current.result).toEqual({ status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' });
    expect(result.current.error).toBeNull();
  });

  it('POSITIVO — resposta "duplicado" vai para status "duplicado" (nunca "enviado")', async () => {
    enviarComprobante.mockResolvedValue({ status: 'duplicado', numeroComprobante: 'C-ORIGINAL', codAutorizacion: 'A-ORIGINAL', jaFaturado: true });
    const { result } = renderHook(() => useSendComprobanteToAxonico(service));

    await act(async () => result.current.send(COMMAND));

    await waitFor(() => expect(result.current.status).toBe('duplicado'));
    expect(result.current.result?.numeroComprobante).toBe('C-ORIGINAL');
  });

  it('NEGATIVO — erro do serviço vai para status "error" com a mensagem, e o botão pode tentar de novo', async () => {
    enviarComprobante.mockRejectedValueOnce(new AxonicoComprobanteServiceError('ConflictoDeFaturamento', 'Ya fue facturado.'));
    const { result } = renderHook(() => useSendComprobanteToAxonico(service));

    await act(async () => result.current.send(COMMAND));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('Ya fue facturado.');

    // Reintentar: novo send() bem-sucedido limpa o erro anterior.
    enviarComprobante.mockResolvedValueOnce({ status: 'enviado', numeroComprobante: 'C-2', codAutorizacion: 'A-2' });
    await act(async () => result.current.send(COMMAND));
    await waitFor(() => expect(result.current.status).toBe('enviado'));
    expect(result.current.error).toBeNull();
  });

  it('NEGATIVO — erro não reconhecido (nem AxonicoComprobanteServiceError nem Error) cai no fallback genérico', async () => {
    enviarComprobante.mockRejectedValueOnce('boom');
    const { result } = renderHook(() => useSendComprobanteToAxonico(service));

    await act(async () => result.current.send(COMMAND));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('No se pudo enviar la prestación.');
  });

  /**
   * PROVA DE SABOTAGEM (c) — clique duplo. Ver bloco de evidência no relatório final: com o
   * `if (inFlightRef.current) return;` removido de `useSendComprobanteToAxonico.ts`, este teste
   * fica VERMELHO (2 chamadas em vez de 1). Restaurado por `cp`, fica VERDE de novo.
   */
  it('POSITIVO — duas chamadas de send() de volta a volta, ANTES da primeira Promise resolver, resultam em UMA SÓ chamada ao serviço', async () => {
    const { promise, resolve } = deferred<EnviarComprobanteAxonicoResult>();
    enviarComprobante.mockReturnValue(promise);
    const { result } = renderHook(() => useSendComprobanteToAxonico(service));

    act(() => {
      result.current.send(COMMAND);
      result.current.send(COMMAND); // segunda chamada, síncrona, ANTES de qualquer await — não passa pelo Button.
    });

    expect(enviarComprobante).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' });
      await promise;
    });
    await waitFor(() => expect(result.current.status).toBe('enviado'));
    expect(enviarComprobante).toHaveBeenCalledTimes(1);
  });

  it('POSITIVO — depois que a primeira corrida termina, um NOVO send() é aceito normalmente (a trava é só ENQUANTO em voo)', async () => {
    enviarComprobante.mockResolvedValueOnce({ status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' });
    const { result } = renderHook(() => useSendComprobanteToAxonico(service));

    await act(async () => result.current.send(COMMAND));
    await waitFor(() => expect(result.current.status).toBe('enviado'));

    enviarComprobante.mockResolvedValueOnce({ status: 'enviado', numeroComprobante: 'C-2', codAutorizacion: 'A-2' });
    await act(async () => result.current.send(COMMAND));
    await waitFor(() => expect(result.current.result?.numeroComprobante).toBe('C-2'));
    expect(enviarComprobante).toHaveBeenCalledTimes(2);
  });
});
