/**
 * backoff — fórmula de backoff exponencial+jitter compartilhada entre chamadores HTTP com
 * retry (achado 2 da F2 de `anacare-conferencia-de-horas`: as constantes
 * `BASE_DELAY_MS=700`/`BACKOFF_FACTOR=2.5`/`MAX_DELAY_MS=8000`/`JITTER_RATIO=0.25` eram cópia
 * literal entre `gemini-fetch.ts::fetchGeminiWithRetry` e `AnaCareRateLimiter.ts`).
 *
 * Escopo desta extração: SÓ a fórmula numérica do atraso (delay = min(base*factor^n, max) ±
 * jitter). A classificação de "isso é transiente?" fica em cada chamador — Gemini (status 429
 * ou 5xx do Vertex) e Ana Care (429/5xx do `AnaCareHttpError`, ou timeout de rede) já tinham, e
 * continuam tendo, seus próprios classificadores; esta função não teria como servir aos dois se
 * fosse forçá-los a concordar no que é retryable.
 */
export const BACKOFF_BASE_DELAY_MS = 700;
export const BACKOFF_FACTOR = 2.5;
export const BACKOFF_MAX_DELAY_MS = 8000;
/** Até ±25% de aleatoriedade para chamadores concorrentes não retentarem em lockstep. */
export const BACKOFF_JITTER_RATIO = 0.25;

export interface BackoffOptions {
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  /** Injeção de aleatoriedade — default `Math.random`; testes fixam para determinismo. */
  random?: () => number;
}

/** attempt=0 é a primeira tentativa de retry (após a 1a chamada já ter falhado). */
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const baseDelayMs = options.baseDelayMs ?? BACKOFF_BASE_DELAY_MS;
  const factor = options.factor ?? BACKOFF_FACTOR;
  const maxDelayMs = options.maxDelayMs ?? BACKOFF_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? BACKOFF_JITTER_RATIO;
  const random = options.random ?? Math.random;

  const raw = baseDelayMs * Math.pow(factor, attempt);
  const capped = Math.min(raw, maxDelayMs);
  const jitter = capped * jitterRatio * (random() * 2 - 1);
  return Math.round(capped + jitter);
}
