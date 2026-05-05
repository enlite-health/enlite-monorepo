import { GeocodingService } from '../../../infrastructure/services/GeocodingService';
import type { PatientAddress } from '../../../infrastructure/repositories/PatientRepository';

export interface GeocodedPatientAddress {
  /** Original address as provided. */
  address: PatientAddress;
  /** Resolved coordinates, or null when geocoding failed/skipped. */
  lat: number | null;
  lng: number | null;
}

/**
 * Build a query string from a `PatientAddress` for geocoding.
 * Prefers `addressFormatted`, falls back to `addressRaw`, and appends
 * city/state/country when only the raw fragment is available so the
 * geocoder can disambiguate (e.g. "Bolivia 4145" → "Bolivia 4145, Caseros,
 * Buenos Aires, Argentina").
 */
export function buildGeocodingQuery(a: PatientAddress, country = 'AR'): string | null {
  const formatted = (a.addressFormatted ?? '').trim();
  if (formatted) return formatted;

  const raw = (a.addressRaw ?? '').trim();
  if (!raw) return null;

  const parts = [
    raw,
    a.neighborhood?.trim(),
    a.city?.trim(),
    a.state?.trim(),
    country === 'AR' ? 'Argentina' : country,
  ].filter((p): p is string => !!p);

  return parts.join(', ');
}

/**
 * Best-effort geocoding for a list of patient addresses.
 *
 * Never throws — caller-side errors (Maps quota exhausted, API down, key
 * missing) result in `lat`/`lng` being null, so the surrounding write path
 * can still persist the address. Operations can run a backfill job later
 * to recover the unresolved rows.
 *
 * Tunables:
 *  - `delayMs`: per-call delay inside `geocodeBatch`. 0 for online flows
 *    (≤3 addresses per patient, latency matters), ~200ms for batch jobs.
 *  - `timeoutMs`: hard cap for the whole batch. Beyond this we abandon and
 *    return null for everyone — protects the upsert from external slowness.
 */
export async function geocodePatientAddressesBestEffort(
  addresses: PatientAddress[],
  geocoder: GeocodingService,
  opts: { delayMs?: number; timeoutMs?: number; country?: string } = {},
): Promise<GeocodedPatientAddress[]> {
  const { delayMs = 0, timeoutMs = 8000, country = 'AR' } = opts;

  if (addresses.length === 0) return [];

  const queries = addresses.map((a) => buildGeocodingQuery(a, country));
  const indexedToResolve = queries
    .map((q, i) => ({ q, i }))
    .filter((x): x is { q: string; i: number } => x.q !== null);

  if (indexedToResolve.length === 0) {
    return addresses.map((address) => ({ address, lat: null, lng: null }));
  }

  const queriesToResolve = indexedToResolve.map((x) => x.q);

  const batchPromise = geocoder.geocodeBatch(queriesToResolve, country, delayMs);
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs),
  );

  const settled = await Promise.race([batchPromise, timeoutPromise]).catch(() => null);

  // Map results back to original input order
  const out: GeocodedPatientAddress[] = addresses.map((address) => ({
    address,
    lat: null,
    lng: null,
  }));

  if (Array.isArray(settled)) {
    settled.forEach((res, idx) => {
      const originalIdx = indexedToResolve[idx].i;
      if (res) {
        out[originalIdx].lat = res.latitude;
        out[originalIdx].lng = res.longitude;
      }
    });
  }

  return out;
}
