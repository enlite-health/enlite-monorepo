/**
 * gemini-fetch
 *
 * Shared helper for calling the Gemini REST API with bounded retry on
 * transient errors (HTTP 429 + 5xx). Gemini frequently returns 503
 * "model overloaded" during demand spikes — retrying with exponential
 * backoff turns those into successful calls.
 *
 * Non-transient errors (4xx other than 429) fail immediately.
 * Network errors (fetch throws) are also treated as transient.
 *
 * In test environments (NODE_ENV === 'test') the backoff delay is 0,
 * keeping unit tests fast.
 */

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 3;

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function delayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  return BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt);
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
 * @throws         On non-transient HTTP errors (immediate) or after
 *                 exhausting retries on transient ones. Error message
 *                 keeps the existing `Gemini API error ${status}: ${body}`
 *                 format so callers/tests don't change.
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
      console.warn(
        `[${logTag}] Network error on attempt ${attempt + 1}/${MAX_ATTEMPTS}: ${err instanceof Error ? err.message : String(err)}` +
          (isLast ? ' — giving up' : ` — retrying in ${delayMs(attempt)}ms`),
      );
      if (isLast) throw err;
      await sleep(delayMs(attempt));
      continue;
    }

    if (response.ok) return response;

    if (!isTransientStatus(response.status)) {
      const errBody = await response.text();
      console.error(
        `[${logTag}] Gemini API error HTTP ${response.status}: ${errBody}`,
      );
      throw new Error(`Gemini API error ${response.status}: ${errBody}`);
    }

    const errBody = await response.text();
    lastError = new Error(`Gemini API error ${response.status}: ${errBody}`);
    const isLast = attempt === MAX_ATTEMPTS - 1;
    console.warn(
      `[${logTag}] Transient HTTP ${response.status} on attempt ${attempt + 1}/${MAX_ATTEMPTS}` +
        (isLast ? ' — giving up' : ` — retrying in ${delayMs(attempt)}ms`),
    );
    if (isLast) {
      console.error(
        `[${logTag}] Gemini API error HTTP ${response.status}: ${errBody}`,
      );
      throw lastError;
    }
    await sleep(delayMs(attempt));
  }

  // Unreachable — loop either returns or throws.
  throw lastError instanceof Error
    ? lastError
    : new Error('Gemini API error: exhausted retries');
}
