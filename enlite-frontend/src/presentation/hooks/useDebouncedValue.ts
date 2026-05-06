import { useState, useEffect } from 'react';

/**
 * Debounces a value — returns the value only after `delay` ms have elapsed
 * since the last change. Useful for search inputs that trigger API calls.
 *
 * @param value  The value to debounce
 * @param delay  Delay in milliseconds (default 300)
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
