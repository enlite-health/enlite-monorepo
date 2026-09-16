/**
 * gemini-fetch
 *
 * Shared helper for calling the Gemini REST API with bounded retry on
 * transient errors (HTTP 429 + 5xx). Gemini frequently returns 503
 * "model overloaded" during demand spikes — and the Vertex `global`
 * endpoint runs gemini-2.5 under Dynamic Shared Quota (DSQ), which 429s
 * with a bare "Resource has been exhausted" whenever the shared pool is
 * momentarily congested (no fixed project quota to raise). Both are
 * transient: retrying with exponential backoff + jitter rides them out.
 *
 * Backoff is capped and jittered so a saturation window of tens of
 * seconds is absorbed without all callers retrying in lockstep, while
 * staying within the ~60s Firebase Hosting rewrite timeout that fronts
 * the synchronous generate-ai-content path (see FOLLOWUPS TD-035).
 *
 * Non-transient errors (4xx other than 429) fail immediately.
 * Network errors (fetch throws) are also treated as transient.
 *
 * In test environments (NODE_ENV === 'test') the backoff delay is 0,
 * keeping unit tests fast.
 *
 * The exponential+jitter delay formula itself lives in `shared/http/backoff.ts`, shared with
 * `AnaCareRateLimiter.ts` (extracted to kill a literal constant duplication — see F2 of
 * `anacare-conferencia-de-horas`). Only the formula is shared: what counts as "transient" stays
 * local to each caller (`isTransientStatus` below is Gemini-specific).
 */
import { computeBackoffDelayMs } from '@shared/http/backoff';

const MAX_ATTEMPTS = 5;

/**
 * Error thrown when a Gemini/Vertex call fails with an HTTP status.
 * Carries the status so callers can map quota/overload (429) to a
 * friendly, retryable response instead of leaking the raw API body.
 * Message keeps the legacy `Gemini API error ${status}: ${body}` format.
 */
export class GeminiApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Gemini API error ${status}: ${body}`);
    this.name = 'GeminiApiError';
  }

  /** 429 (quota/DSQ) or 5xx (overload) — safe for the user to retry. */
  get isTransient(): boolean {
    return isTransientStatus(this.status);
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function delayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  return computeBackoffDelayMs(attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches a Gemini endpoint with retry on transient failures.
 *
 * @param url      Full Gemini API URL (including `?key=...`)
 * @param init     Standard fetch RequestInit (method/headers/body)
 * @param logTag   Short tag prefixed to log lines (e.g. 'GeminiParser')
 * @returns        The successful Response. Caller is responsible for
 *                 reading `.json()` / `.text()`.
 * @throws         `GeminiApiError` on HTTP errors (immediate for
 *                 non-transient, after exhausting retries for transient
 *                 ones), or the raw network error if `fetch` keeps
 *                 throwing. Message keeps the existing
 *                 `Gemini API error ${status}: ${body}` format.
 */
export async function fetchGeminiWithRetry(
  url: string,
  init: RequestInit,
  logTag: string,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      lastError = err;
      const isLast = attempt === MAX_ATTEMPTS - 1;
      const wait = delayMs(attempt);
      console.warn(
        `[${logTag}] Network error on attempt ${attempt + 1}/${MAX_ATTEMPTS}: ${err instanceof Error ? err.message : String(err)}` +
          (isLast ? ' — giving up' : ` — retrying in ${wait}ms`),
      );
      if (isLast) throw err;
      await sleep(wait);
      continue;
    }

    if (response.ok) return response;

    const errBody = await response.text();

    if (!isTransientStatus(response.status)) {
      console.error(
        `[${logTag}] Gemini API error HTTP ${response.status}: ${errBody}`,
      );
      throw new GeminiApiError(response.status, errBody);
    }

    lastError = new GeminiApiError(response.status, errBody);
    const isLast = attempt === MAX_ATTEMPTS - 1;
    const wait = delayMs(attempt);
    console.warn(
      `[${logTag}] Transient HTTP ${response.status} on attempt ${attempt + 1}/${MAX_ATTEMPTS}` +
        (isLast ? ' — giving up' : ` — retrying in ${wait}ms`),
    );
    if (isLast) {
      console.error(
        `[${logTag}] Gemini API error HTTP ${response.status}: ${errBody}`,
      );
      throw lastError;
    }
    await sleep(wait);
  }

  // Unreachable — loop either returns or throws.
  throw lastError instanceof Error
    ? lastError
    : new Error('Gemini API error: exhausted retries');
}
