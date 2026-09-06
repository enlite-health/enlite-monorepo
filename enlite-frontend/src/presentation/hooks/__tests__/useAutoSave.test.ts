import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoSave } from '../useAutoSave';

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return a triggerSave function', () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave(saveFn));

    expect(typeof result.current).toBe('function');
  });

  it('should call saveFn after the debounce delay', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave(saveFn, 300));

    act(() => {
      result.current();
    });

    // Not called yet (debounce pending)
    expect(saveFn).not.toHaveBeenCalled();

    // Advance time past the debounce delay
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it('should debounce multiple rapid calls into one save', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave(saveFn, 500));

    act(() => {
      result.current();
    });
    act(() => {
      result.current();
    });
    act(() => {
      result.current();
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it('should reset debounce timer on each new call', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave(saveFn, 500));

    act(() => {
      result.current();
    });

    // Advance 400ms (not yet expired)
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(saveFn).not.toHaveBeenCalled();

    // Trigger again - resets the 500ms timer
    act(() => {
      result.current();
    });

    // Advance another 400ms (800ms total, but only 400ms since last trigger)
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(saveFn).not.toHaveBeenCalled();

    // Advance remaining 100ms to complete the 500ms from last trigger
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it('should queue a pending save if called while already saving', async () => {
    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const saveFn = vi.fn()
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValue(undefined);

    const { result } = renderHook(() => useAutoSave(saveFn, 100));

    // First trigger
    act(() => {
      result.current();
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(saveFn).toHaveBeenCalledTimes(1);

    // Trigger again while first save is in progress
    act(() => {
      result.current();
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // First save still in progress, second call is queued
    // Resolve first save
    await act(async () => {
      resolveFirst!();
    });

    // The pending save should now execute
    expect(saveFn).toHaveBeenCalledTimes(2);
  });

  it('should not throw if saveFn rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saveFn = vi.fn().mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useAutoSave(saveFn, 100));

    act(() => {
      result.current();
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('[AutoSave] Failed:', expect.any(Error));

    consoleSpy.mockRestore();
  });

  it('should use the latest saveFn closure on each execution', async () => {
    let callCount = 0;
    const saveFn1 = vi.fn().mockImplementation(async () => { callCount = 1; });
    const saveFn2 = vi.fn().mockImplementation(async () => { callCount = 2; });

    const { result, rerender } = renderHook(
      ({ fn }) => useAutoSave(fn, 200),
      { initialProps: { fn: saveFn1 } },
    );

    act(() => {
      result.current();
    });

    // Update the save function before the debounce fires
    rerender({ fn: saveFn2 });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    // Should use the latest closure (saveFn2), not the original one
    expect(callCount).toBe(2);
    expect(saveFn1).not.toHaveBeenCalled();
    expect(saveFn2).toHaveBeenCalledTimes(1);
  });

  // Este teste travava o comportamento ANTIGO ("não salva depois do unmount") — e o
  // comportamento antigo era o defeito. Estas telas não têm botão Guardar: o autosave
  // é a única chance de persistir, então quem mexe num campo e troca de aba dentro da
  // janela de debounce perdia o que acabou de digitar, sem erro e sem aviso.
  it('envia o save pendente ao desmontar, em vez de descartá-lo', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutoSave(saveFn, 500));

    act(() => {
      result.current();
    });

    // Desmonta ANTES de o debounce vencer — o caso que perdia dado.
    await act(async () => {
      unmount();
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it('não dispara save nenhum ao desmontar quando nada estava pendente', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useAutoSave(saveFn, 500));

    await act(async () => {
      unmount();
    });

    expect(saveFn).not.toHaveBeenCalled();
  });

  it('engole erro do save no unmount (não há mais tela para mostrar toast)', async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useAutoSave(saveFn, 500, onError));

    act(() => {
      result.current();
    });

    await act(async () => {
      unmount();
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it('should respect custom delay parameter', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave(saveFn, 1000));

    act(() => {
      result.current();
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(saveFn).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
  });
});
