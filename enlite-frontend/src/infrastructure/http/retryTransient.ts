import { ApiError } from './ApiError';

/**
 * Transient = worth retrying. Definitive client-side denials (4xx via `ApiError`
 * — not authenticated / not admin / not found) are NOT retried; a 5xx envelope
 * or any non-`ApiError` throw (network reject, non-JSON cold-start response) is.
 */
export function isTransientApiError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status >= 500;
  }
  return true;
}

/**
 * Runs `fn`, retrying on transient failures with the given backoff. Used by the
 * auth-gating profile fetch: on a Cloud Run cold start the backend often answers
 * with a 503 HTML body (non-JSON → `response.json()` throws) or refuses the
 * connection before the container is warm. Without a retry the admin login shows
 * a misleading "não possui permissões de administrador" for a mere network hiccup.
 *
 * `maxAttempts = delaysMs.length + 1` (one initial try + one retry per delay).
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = [300, 800],
  isTransient: (err: unknown) => boolean = isTransientApiError,
): Promise<T> {
  const maxAttempts = delaysMs.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isTransient(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error('withTransientRetry: exhausted attempts');
}
