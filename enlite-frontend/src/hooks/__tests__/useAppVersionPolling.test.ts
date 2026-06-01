/**
 * useAppVersionPolling — testes unitários.
 *
 * O hook só age quando há um `<script src="/assets/index-<HASH>.js">` no DOM,
 * o que acontece no build de produção. Em dev (Vite serving sem hash), o hook
 * é no-op intencional. Cobrimos:
 *   - retorna false até detectar divergência
 *   - retorna true quando fetch retorna hash diferente
 *   - retorna false quando fetch retorna mesmo hash
 *   - permanece false em dev mode (DOM sem script com hash)
 *   - tolera fetch failure (não dispara false-positive)
 *   - para de pollar após detectar (não vaza intervals)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAppVersionPolling } from '../useAppVersionPolling';

const CURRENT_HASH = 'AbCdEf12';
const NEW_HASH = 'XyZ98765';

function installScriptInDom(hash: string): HTMLScriptElement {
  const script = document.createElement('script');
  script.setAttribute('src', `/assets/index-${hash}.js`);
  document.head.appendChild(script);
  return script;
}

function htmlWithHash(hash: string): string {
  return `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-${hash}.js"></script></head><body></body></html>`;
}

describe('useAppVersionPolling', () => {
  let originalFetch: typeof globalThis.fetch;
  let scripts: HTMLScriptElement[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;
    scripts = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    scripts.forEach((s) => s.remove());
    scripts = [];
  });

  it('returns false initially', () => {
    scripts.push(installScriptInDom(CURRENT_HASH));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlWithHash(CURRENT_HASH),
    } as Response);

    const { result } = renderHook(() => useAppVersionPolling({ intervalMs: 1000 }));
    expect(result.current).toBe(false);
  });

  it('returns true when fetched bundle hash differs from in-memory script', async () => {
    scripts.push(installScriptInDom(CURRENT_HASH));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlWithHash(NEW_HASH),
    } as Response);

    const { result } = renderHook(() => useAppVersionPolling({ intervalMs: 1000 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current).toBe(true);
  });

  it('stays false when fetched bundle hash matches in-memory script', async () => {
    scripts.push(installScriptInDom(CURRENT_HASH));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlWithHash(CURRENT_HASH),
    } as Response);

    const { result } = renderHook(() => useAppVersionPolling({ intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toBe(false);
  });

  it('stays false in dev mode (no script with hash in DOM)', async () => {
    // No installScriptInDom — DOM doesn't have a script with /assets/index-<HASH>.js
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlWithHash(NEW_HASH),
    } as Response);

    const { result } = renderHook(() => useAppVersionPolling({ intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('tolerates fetch failure without flipping to true', async () => {
    scripts.push(installScriptInDom(CURRENT_HASH));
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useAppVersionPolling({ intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toBe(false);
  });

  it('stops polling once divergence is detected', async () => {
    scripts.push(installScriptInDom(CURRENT_HASH));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlWithHash(NEW_HASH),
    } as Response);
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useAppVersionPolling({ intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toBe(true);

    const callsAtDetection = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAtDetection);
  });
});
