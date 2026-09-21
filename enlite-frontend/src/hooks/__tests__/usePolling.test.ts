/**
 * usePolling — testes unitários.
 *
 * Cobre:
 *   - chama `fn` a cada `ms`
 *   - pausa quando `document.visibilityState` vira 'hidden' e retoma ao voltar
 *   - cleanup no unmount: `fn` não é chamada depois de desmontar (timer não vaza)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePolling } from '../usePolling';

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('chama fn a cada ms', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));

    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('pausa quando a aba fica oculta e retoma quando volta a ficar visível', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { pauseWhenHidden: true }));

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1); // pausado — nenhuma chamada nova

    setVisibility('visible');
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2); // retomou
  });

  it('monta já oculto com pauseWhenHidden: não inicia até ficar visível', () => {
    setVisibility('hidden');
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { pauseWhenHidden: true }));

    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();

    setVisibility('visible');
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sem pauseWhenHidden (default), continua pollando com a aba oculta', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));

    setVisibility('hidden');
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cleanup: ao desmontar, o intervalo para e fn não é chamada depois', () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000));

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    unmount();

    // Se o intervalo tivesse vazado, essas chamadas de tempo continuariam
    // incrementando fn — é o defeito clássico (aba esquecida vira tráfego
    // contínuo contra a API de produção).
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('eventos de visibilitychange repetidos para o mesmo estado são idempotentes (não duplica nem trava o intervalo)', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { pauseWhenHidden: true }));

    // 'visible' de novo enquanto já está visível — não deve criar um 2º intervalo
    setVisibility('visible');
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // 'hidden' duas vezes em sequência — a 2ª não deve quebrar o estado parado
    setVisibility('hidden');
    setVisibility('hidden');
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cleanup remove o listener de visibilitychange no unmount', () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000, { pauseWhenHidden: true }));

    unmount();

    // depois de desmontado, mudar a visibilidade não deve reativar nada
    // (não há mais timer para retomar) — fn permanece intocada.
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
