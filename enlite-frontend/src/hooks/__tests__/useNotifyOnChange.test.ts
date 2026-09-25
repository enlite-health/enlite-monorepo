import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNotifyOnChange } from '../useNotifyOnChange';

describe('useNotifyOnChange', () => {
  it('não chama onChange no mount', () => {
    const onChange = vi.fn();
    renderHook(({ value }) => useNotifyOnChange(value, onChange), { initialProps: { value: false } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('chama onChange quando o valor muda', () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(({ value }) => useNotifyOnChange(value, onChange), {
      initialProps: { value: false },
    });
    rerender({ value: true });
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('não chama onChange de novo se o valor se repete', () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(({ value }) => useNotifyOnChange(value, onChange), {
      initialProps: { value: 1 },
    });
    rerender({ value: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
