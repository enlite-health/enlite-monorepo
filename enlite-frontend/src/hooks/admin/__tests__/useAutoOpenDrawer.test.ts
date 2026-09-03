import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoOpenDrawer } from '../useAutoOpenDrawer';

describe('useAutoOpenDrawer (spec 014 US-D1: checklist abre o drawer certo)', () => {
  it('request null → não abre', () => {
    const open = vi.fn();
    renderHook(() => useAutoOpenDrawer(null, 'ADDRESS', open));
    expect(open).not.toHaveBeenCalled();
  });

  it('request de OUTRO código → não abre', () => {
    const open = vi.fn();
    renderHook(() => useAutoOpenDrawer({ code: 'COVERAGE', token: 1 }, 'ADDRESS', open));
    expect(open).not.toHaveBeenCalled();
  });

  it('request do MESMO código → abre uma vez', () => {
    const open = vi.fn();
    renderHook(() => useAutoOpenDrawer({ code: 'ADDRESS', token: 1 }, 'ADDRESS', open));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('re-render com o MESMO token → não reabre (evita loop)', () => {
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ request }) => useAutoOpenDrawer(request, 'ADDRESS', open),
      { initialProps: { request: { code: 'ADDRESS', token: 1 } } },
    );
    rerender({ request: { code: 'ADDRESS', token: 1 } });
    rerender({ request: { code: 'ADDRESS', token: 1 } });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('clicar de novo no MESMO item (token novo) → abre de novo', () => {
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ request }) => useAutoOpenDrawer(request, 'ADDRESS', open),
      { initialProps: { request: { code: 'ADDRESS', token: 1 } } },
    );
    rerender({ request: { code: 'ADDRESS', token: 2 } });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('troca de code no mesmo hook (card diferente teria seu próprio ownCode) → só abre quando bate', () => {
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ request }) => useAutoOpenDrawer(request, 'COVERAGE', open),
      { initialProps: { request: { code: 'ADDRESS', token: 1 } } },
    );
    expect(open).not.toHaveBeenCalled();
    rerender({ request: { code: 'COVERAGE', token: 2 } });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
