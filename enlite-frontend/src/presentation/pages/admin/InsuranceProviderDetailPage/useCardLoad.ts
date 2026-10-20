import { useCallback, useEffect, useState } from 'react';

export interface CardLoad<T> {
  data: T | null;
  /** O erro cru da carga (um `InsuranceApiError`, normalmente) — quem decide a frase é o cartão. */
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Carrega os dados de UM cartão. `enabled: false` (sem a célula de leitura) não chama a API: o cartão mostra "sem permissão"
 * em vez de provocar um 403 que a pessoa não consegue resolver.
 */
export function useCardLoad<T>(load: () => Promise<T>, enabled: boolean, deps: readonly unknown[]): CardLoad<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    load()
      .then((res) => { if (!cancelled) { setData(res); setError(null); } })
      .catch((err: unknown) => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tick, ...deps]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** `true` quando o erro é um 403 (a API recusou a leitura por falta de célula). */
export function isForbidden(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 403;
}
