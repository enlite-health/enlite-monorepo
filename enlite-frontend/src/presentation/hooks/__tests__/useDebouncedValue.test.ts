import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from '../useDebouncedValue';

describe('useDebouncedValue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('hello', 300));
    expect(result.current).toBe('hello');
  });

  it('does not update the value before the delay elapses', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    act(() => { vi.advanceTimersByTime(100); });

    expect(result.current).toBe('a');
  });

  it('updates the value after the delay elapses', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    act(() => { vi.advanceTimersByTime(300); });

    expect(result.current).toBe('b');
  });

  it('resets the timer when the value changes before delay', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    act(() => { vi.advanceTimersByTime(200); });
    rerender({ value: 'c' });
    act(() => { vi.advanceTimersByTime(200); });

    // 200ms after last change — not yet debounced
    expect(result.current).toBe('a');

    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe('c');
  });

  it('uses default delay of 300ms when no delay specified', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useDebouncedValue(value),
      { initialProps: { value: 0 } },
    );

    rerender({ value: 42 });
    act(() => { vi.advanceTimersByTime(299); });
    expect(result.current).toBe(0);

    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(42);
  });

  it('works with object values', () => {
    vi.useFakeTimers();
    const initial = { a: 1 };
    const next = { a: 2 };
    const { result, rerender } = renderHook(
      ({ value }: { value: { a: number } }) => useDebouncedValue(value, 100),
      { initialProps: { value: initial } },
    );

    rerender({ value: next });
    act(() => { vi.advanceTimersByTime(100); });

    expect(result.current).toEqual({ a: 2 });
  });
});
