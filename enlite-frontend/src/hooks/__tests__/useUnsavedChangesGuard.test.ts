import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUnsavedChangesGuard } from '../useUnsavedChangesGuard';

describe('useUnsavedChangesGuard', () => {
  it('sujo bloqueia a saída até confirmar', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard());
    const action = vi.fn();

    act(() => result.current.markDirty());
    act(() => result.current.guardedAction(action));

    expect(action).not.toHaveBeenCalled();
    expect(result.current.isConfirmOpen).toBe(true);

    act(() => result.current.confirmDiscard());

    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.isConfirmOpen).toBe(false);
  });

  it('limpo não bloqueia a saída', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard());
    const action = vi.fn();

    act(() => result.current.guardedAction(action));

    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.isConfirmOpen).toBe(false);
  });

  it('gravou e saiu não bloqueia', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard());
    const action = vi.fn();

    act(() => result.current.markDirty());
    act(() => result.current.markClean());
    act(() => result.current.guardedAction(action));

    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.isConfirmOpen).toBe(false);
  });

  it('cancelar a confirmação mantém sujo e não roda a ação pendente', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard());
    const action = vi.fn();

    act(() => result.current.markDirty());
    act(() => result.current.guardedAction(action));
    act(() => result.current.cancelDiscard());

    expect(action).not.toHaveBeenCalled();
    expect(result.current.isConfirmOpen).toBe(false);

    // ainda sujo: uma nova guardedAction volta a abrir a confirmação
    const action2 = vi.fn();
    act(() => result.current.guardedAction(action2));
    expect(action2).not.toHaveBeenCalled();
    expect(result.current.isConfirmOpen).toBe(true);
  });

  it('beforeunload: previne o unload quando sujo, ignora quando limpo', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard());

    const dirtyEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    act(() => result.current.markDirty());
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    const cleanEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    act(() => result.current.markClean());
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });
});
