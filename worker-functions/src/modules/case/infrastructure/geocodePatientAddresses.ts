import * as functions from 'firebase-functions';
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
 *  - `known`: coordenadas que JÁ temos, indexadas pela mesma string que
 *    `buildGeocodingQuery` produz. O que estiver aqui não vai ao Google.
 *
 * 🔒 POR QUE `known` EXISTE (06/09/2026). A rede de segurança do ClickUp roda a
 * cada 10 min com janela de 30 — cada card alterado é reprocessado ~3 vezes, e
 * cada passagem regeocodificava TODOS os endereços do paciente, mesmo com o
 * texto inalterado e a coordenada já gravada. Medido em produção: 132 chamadas
 * por hora, 24h por dia, inclusive de madrugada; ~95 mil/mês contra uma
 * franquia de 10 mil. Pagávamos ao Google para reresponder o que já sabíamos.
 * Quem chama é responsável por montar o mapa a partir do banco ANTES de apagar
 * as linhas — ver `PatientRelatedWriter` e `PatientRepository.replaceAddresses`.
 */
export async function geocodePatientAddressesBestEffort(
  addresses: PatientAddress[],
  geocoder: GeocodingService,
  opts: {
    delayMs?: number;
    timeoutMs?: number;
    country?: string;
    known?: ReadonlyMap<string, { lat: number; lng: number }>;
  } = {},
): Promise<GeocodedPatientAddress[]> {
  const { delayMs = 0, timeoutMs = 8000, country = 'AR', known } = opts;

  if (addresses.length === 0) return [];

  const queries = addresses.map((a) => buildGeocodingQuery(a, country));
  // O que já se sabe sai da fila ANTES de qualquer chamada externa: além de não
  // gastar, não manda o endereço para fora de novo.
  const indexedToResolve = queries
    .map((q, i) => ({ q, i }))
    .filter((x): x is { q: string; i: number } => x.q !== null && !known?.has(x.q));

  /** Resultado base: nulo, exceto onde a coordenada já era conhecida. */
  const comConhecidas = (): GeocodedPatientAddress[] =>
    addresses.map((address, i) => {
      const q = queries[i];
      const cache = q ? known?.get(q) : undefined;
      return { address, lat: cache?.lat ?? null, lng: cache?.lng ?? null };
    });

  // ⚠️ Este retorno curto é o caso COMUM em regime: todos os endereços já
  // conhecidos, nada a perguntar. Devolver nulo aqui apagaria a coordenada boa
  // e o próximo ciclo geocodificaria tudo de novo — o vazamento voltaria pela
  // porta dos fundos.
  if (indexedToResolve.length === 0) return comConhecidas();

  const queriesToResolve = indexedToResolve.map((x) => x.q);

  const batchPromise = geocoder.geocodeBatch(queriesToResolve, country, delayMs);
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs),
  );

  let timedOut = false;
  const settled = await Promise.race([
    batchPromise,
    timeoutPromise.then(() => { timedOut = true; return null; }),
  ]).catch((err: unknown) => {
    functions.logger.warn('geocoding.failed', {
      queryLength:  queriesToResolve[0]?.length ?? 0,
      hasFormatted: indexedToResolve.some(x => !!addresses[x.i].addressFormatted),
      hasRaw:       indexedToResolve.some(x => !!addresses[x.i].addressRaw),
      state:        addresses[0]?.state ?? null,
      city:         addresses[0]?.city  ?? null,
      error:        err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  if (timedOut) {
    functions.logger.warn('geocoding.batch_timeout', {
      totalAddresses: addresses.length,
      timeoutMs,
    });
  }

  // Map results back to original input order, já com o que era conhecido.
  const out: GeocodedPatientAddress[] = comConhecidas();

  if (Array.isArray(settled)) {
    settled.forEach((res, idx) => {
      const originalIdx = indexedToResolve[idx].i;
      if (res) {
        out[originalIdx].lat = res.latitude;
        out[originalIdx].lng = res.longitude;
      } else {
        const a = addresses[originalIdx];
        functions.logger.warn('geocoding.failed', {
          queryLength:  indexedToResolve[idx].q.length,
          hasFormatted: !!a.addressFormatted,
          hasRaw:       !!a.addressRaw,
          state:        a.state ?? null,
          city:         a.city  ?? null,
          error:        'null result (ZERO_RESULTS or precision rejected)',
        });
      }
    });
  }

  return out;
}
