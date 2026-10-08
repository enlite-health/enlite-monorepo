import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTableSort } from '../useTableSort';

describe('useTableSort', () => {
  it('começa sem ordenação', () => {
    const { result } = renderHook(() => useTableSort<'a' | 'b'>());
    expect(result.current.sort).toBeNull();
  });

  it('clique em outra coluna -> asc', () => {
    const { result } = renderHook(() => useTableSort<'a' | 'b'>());
    act(() => result.current.toggle('a'));
    expect(result.current.sort).toEqual({ key: 'a', direction: 'asc' });
    act(() => result.current.toggle('b'));
    expect(result.current.sort).toEqual({ key: 'b', direction: 'asc' });
  });

  it('clique na mesma coluna alterna asc/desc, sem 3º estado', () => {
    const { result } = renderHook(() => useTableSort<'a'>());
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      act(() => result.current.toggle('a'));
      seen.push(result.current.sort!.direction);
    }
    expect(seen).toEqual(['asc', 'desc', 'asc', 'desc', 'asc']);
  });

  it('voltar de uma coluna que estava em desc para outra começa em asc', () => {
    const { result } = renderHook(() => useTableSort<'a' | 'b'>());
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('b'));
    expect(result.current.sort).toEqual({ key: 'b', direction: 'asc' });
  });
});
