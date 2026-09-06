import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useConfirmDiscardClose } from '../useConfirmDiscardClose';

describe('useConfirmDiscardClose (spec 014 US-D4, lex D4 AUTORIZADO — drawers não perdem trabalho)', () => {
  it('sem mudanças (isDirty=false) → requestClose fecha DIRETO, sem abrir confirmação', () => {
    const onConfirmedClose = vi.fn();
    const { result } = renderHook(() =>
      useConfirmDiscardClose({ isDirty: false, onConfirmedClose }),
    );

    act(() => result.current.requestClose());

    expect(onConfirmedClose).toHaveBeenCalledTimes(1);
    expect(result.current.confirmingClose).toBe(false);
  });

  it('com mudanças (isDirty=true) → requestClose NÃO fecha, abre a confirmação', () => {
    const onConfirmedClose = vi.fn();
    const { result } = renderHook(() =>
      useConfirmDiscardClose({ isDirty: true, onConfirmedClose }),
    );

    act(() => result.current.requestClose());

    expect(onConfirmedClose).not.toHaveBeenCalled();
    expect(result.current.confirmingClose).toBe(true);
  });

  it('"Seguir editando" (keepEditing) fecha só a confirmação — o drawer permanece aberto, nada descartado', () => {
    const onConfirmedClose = vi.fn();
    const { result } = renderHook(() =>
      useConfirmDiscardClose({ isDirty: true, onConfirmedClose }),
    );

    act(() => result.current.requestClose());
    expect(result.current.confirmingClose).toBe(true);

    act(() => result.current.keepEditing());

    expect(result.current.confirmingClose).toBe(false);
    expect(onConfirmedClose).not.toHaveBeenCalled();
  });

  it('"Descartar cambios" (confirmDiscard) chama onConfirmedClose e fecha a confirmação', () => {
    const onConfirmedClose = vi.fn();
    const { result } = renderHook(() =>
      useConfirmDiscardClose({ isDirty: true, onConfirmedClose }),
    );

    act(() => result.current.requestClose());
    act(() => result.current.confirmDiscard());

    expect(onConfirmedClose).toHaveBeenCalledTimes(1);
    expect(result.current.confirmingClose).toBe(false);
  });

  it('salvar nunca passa por aqui: chamar onConfirmedClose diretamente (sem requestClose) não abre confirmação mesmo dirty', () => {
    const onConfirmedClose = vi.fn();
    const { result } = renderHook(() =>
      useConfirmDiscardClose({ isDirty: true, onConfirmedClose }),
    );

    act(() => result.current.onConfirmedClose());

    expect(onConfirmedClose).toHaveBeenCalledTimes(1);
    expect(result.current.confirmingClose).toBe(false);
  });
});
