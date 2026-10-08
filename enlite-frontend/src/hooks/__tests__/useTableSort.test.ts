import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTableSort } from '../useTableSort';

describe('useTableSort', () => {
  it('começa sem ordenação', () => {
    const { result } = renderHook(() => useTableSort<'a' | 'b'>());
    expect(result.current.sort).toBeNull();
  });

  it('clique em outra coluna -> desc', () => {
    const { result } = renderHook(() => useTableSort<'a' | 'b'>());
    act(() => result.current.toggle('a'));
    expect(result.current.sort).toEqual({ key: 'a', direction: 'desc' });
    act(() => result.current.toggle('b'));
    expect(result.current.sort).toEqual({ key: 'b', direction: 'desc' });
  });

  it('clique na mesma coluna alterna desc/asc, sem 3º estado', () => {
    const { result } = renderHook(() => useTableSort<'a'>());
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      act(() => result.current.toggle('a'));
      seen.push(result.current.sort!.direction);
    }
    expect(seen).toEqual(['desc', 'asc', 'desc', 'asc', 'desc']);
  });

  it('voltar de uma coluna que estava em asc para outra começa em desc', () => {
    const { result } = renderHook(() => useTableSort<'a' | 'b'>());
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('b'));
    expect(result.current.sort).toEqual({ key: 'b', direction: 'desc' });
  });
});
