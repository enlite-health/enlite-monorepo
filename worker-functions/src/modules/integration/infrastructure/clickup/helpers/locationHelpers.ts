/**
 * locationHelpers — pure functions for extracting state/city/neighborhood
 * from ClickUp location custom field values.
 *
 * ClickUp location fields return objects shaped like:
 *   { formatted_address: "San Isidro, Buenos Aires, Argentina", lat: -34.47, lng: -58.52 }
 * OR sometimes just a string (plain text fallback from address_raw).
 *
 * These helpers extract structured sub-fields without touching the database.
 * Following rule: feedback_modularize_to_extreme — utils never write to DB.
 *
 * State/city/neighborhood extraction runs through `argentinaLocationNormalizer`
 * before returning — this is the single write-path border for new ClickUp
 * syncs, so `state` is always a canonical province label (or null), `city`
 * never carries a postal-code prefix, and `neighborhood` never carries the
 * literal string "null". The Fase 1 backfill script (out-of-band) applies the
 * same normalizer to existing dirty rows.
 */
import {
  normalizeProvince,
  stripPostalCodePrefix,
  cleanNullLiteral,
} from '@shared/utils/argentinaLocationNormalizer';

/**
 * Extracts the formatted_address string from a ClickUp location field value.
 * Returns null if the value is not a valid location object.
 */
export function extractFormattedAddressFromLocation(location: unknown): string | null {
  if (!location || typeof location !== 'object') return null;
  const loc = location as Record<string, unknown>;
  if (typeof loc['formatted_address'] !== 'string') return null;
  const trimmed = loc['formatted_address'].trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

/**
 * Collects EVERY address_component `long_name`/`short_name` matching any of
 * `componentTypes`, in the order they appear in `address_components` (Google
 * typically orders most-specific → least-specific). Returns an empty array
 * when there are no structured components or none match.
 */
function collectAddressComponentCandidates(location: unknown, componentTypes: string[]): string[] {
  if (!location || typeof location !== 'object') return [];
  const loc = location as Record<string, unknown>;
  if (!Array.isArray(loc['address_components'])) return [];

  const components = loc['address_components'] as Array<Record<string, unknown>>;
  const candidates: string[] = [];
  for (const comp of components) {
    const types = comp['types'];
    if (!Array.isArray(types)) continue;
    const hasType = componentTypes.some(t => (types as string[]).includes(t));
    if (hasType) {
      const name = comp['long_name'] ?? comp['short_name'];
      if (typeof name === 'string' && name.trim()) candidates.push(name.trim());
    }
  }
  return candidates;
}

/** Default candidate picker — first match wins (previous, non-cascading behavior). */
function pickFirstCandidate(candidates: string[]): string | null {
  return candidates[0] ?? null;
}

/**
 * Extracts a named address component from a ClickUp location field value.
 * Google Maps address_components have type arrays like
 *   [{ long_name: "Buenos Aires", short_name: "BA", types: ["administrative_area_level_1"] }]
 *
 * When `allowFormattedFallback` is true and address_components are missing or do
 * not contain any of the requested types, the function falls back to parsing
 * `formatted_address` by comma segments:
 *   segmentIndex=0 → first segment (locality / city)
 *   segmentIndex=-1 → last non-country segment (state / province)
 *
 * Set `allowFormattedFallback=false` for fields where the formatted_address is
 * a full street address (e.g. "Rivadavia 555, Santa Fe"), where parsing by
 * comma would incorrectly return the street name instead of the city/state.
 *
 * `pickCandidate` lets a caller override the default "first match wins" with
 * cascading logic — e.g. `extractCityFromLocation[Strict]` skips a candidate
 * that turns out to be a bare Argentine postal code (see
 * `pickFirstCleanCity`) and tries the next one instead of settling for null.
 */
function extractAddressComponent(
  location: unknown,
  componentTypes: string[],
  segmentIndex: 0 | -1 = 0,
  allowFormattedFallback: boolean = true,
  pickCandidate: (candidates: string[]) => string | null = pickFirstCandidate,
): string | null {
  const picked = pickCandidate(collectAddressComponentCandidates(location, componentTypes));
  if (picked !== null) return picked;

  if (!allowFormattedFallback) return null;
  if (!location || typeof location !== 'object') return null;
  const loc = location as Record<string, unknown>;

  // Fallback: parse formatted_address by comma segments
  // e.g. "Buenos Aires, CABA, Argentina" → segments ["Buenos Aires","CABA","Argentina"]
  if (typeof loc['formatted_address'] === 'string') {
    const segments = loc['formatted_address']
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (segments.length === 0) return null;
    const idx = segmentIndex === -1 ? Math.max(0, segments.length - 2) : segmentIndex;
    const segment = segments[idx];
    return segment === undefined ? null : pickCandidate([segment]);
  }

  return null;
}

/**
 * Extracts the state (provincia) from a ClickUp location field value.
 * Uses address_components type "administrative_area_level_1".
 * Falls back to first comma segment of formatted_address (safe for
 * patient-level fields like "Provincia del Paciente" that hold "Santa Fe"
 * directly). Result runs through `normalizeProvince` — returns the canonical
 * province label, or null when the raw value is not a recognizable province
 * (e.g. a city name leaked into the field).
 */
export function extractStateFromLocation(location: unknown): string | null {
  const raw = extractAddressComponent(location, ['administrative_area_level_1'], 0, true);
  return normalizeProvince(raw);
}

/**
 * Strict variant of extractStateFromLocation — uses ONLY address_components,
 * never falls back to parsing formatted_address by comma. Use when the location
 * is a full street address (e.g. `Domicilio N Principal Paciente`), where the
 * first comma segment is the street, not the state. Result runs through
 * `normalizeProvince` — see extractStateFromLocation.
 */
export function extractStateFromLocationStrict(location: unknown): string | null {
  const raw = extractAddressComponent(location, ['administrative_area_level_1'], 0, false);
  return normalizeProvince(raw);
}

const CITY_COMPONENT_TYPES = [
  'locality',
  'sublocality_level_1',
  'administrative_area_level_2',
  'neighborhood',
];

/**
 * Picks the first candidate that survives `stripPostalCodePrefix` — cascades
 * past a candidate that is a BARE Argentine postal code (e.g. Google
 * returning "C1126ABC" with no locality name at all — real prod case,
 * `patient_addresses` id a06d5086-90cf-422d-ab05-7431b8aed7ea) instead of
 * settling for null when a usable next-best candidate (sublocality/barrio)
 * exists. Returns null only when EVERY candidate is unusable.
 */
function pickFirstCleanCity(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const cleaned = stripPostalCodePrefix(candidate);
    if (cleaned !== null) return cleaned;
  }
  return null;
}

/**
 * Extracts the city (ciudad / localidad) from a ClickUp location field value.
 * Tries locality, then sublocality_level_1, then administrative_area_level_2,
 * then neighborhood — cascading past any candidate that is a bare Argentine
 * postal code (see `pickFirstCleanCity`). Falls back to first comma segment
 * of formatted_address when no address_components are present. Every
 * candidate (component-based or formatted-address fallback) runs through
 * `stripPostalCodePrefix`. Returns null when not extractable.
 */
export function extractCityFromLocation(location: unknown): string | null {
  return extractAddressComponent(location, CITY_COMPONENT_TYPES, 0, true, pickFirstCleanCity);
}

/**
 * Strict variant of extractCityFromLocation — uses ONLY address_components.
 * Use with full street addresses. Same cascade as extractCityFromLocation —
 * see there.
 */
export function extractCityFromLocationStrict(location: unknown): string | null {
  return extractAddressComponent(location, CITY_COMPONENT_TYPES, 0, false, pickFirstCleanCity);
}

/**
 * Normalizes a neighborhood (zona/barrio) string from a ClickUp short_text field.
 * Trims whitespace and returns null for empty/null values, including the
 * literal string "null" (legacy ClickUp export artifact — see
 * `cleanNullLiteral`).
 */
export function extractNeighborhood(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return cleanNullLiteral(value);
}

/**
 * Extracts the neighborhood (barrio / sublocalidade) from a ClickUp location field value.
 * Tries sublocality_level_1, then sublocality, then neighborhood.
 *
 * Used to keep neighborhood in sync with address_formatted when the operator
 * updates only "Domicilio Principal" in ClickUp (the location field with
 * address_components). The legacy `Zona o Barrio Paciente` short_text field is
 * then used as a fallback when the location field does not provide structured
 * components — see ClickUpPatientMapper.buildAddresses. Result runs through
 * `cleanNullLiteral` to filter out the literal string "null".
 */
export function extractNeighborhoodFromLocation(location: unknown): string | null {
  // Strict: neighborhood from location MUST come from address_components.
  // Formatted_address fallback would yield the street name (first segment),
  // which is wrong. Use the legacy `Zona o Barrio Paciente` short_text field
  // as fallback in the mapper instead.
  const raw = extractAddressComponent(location, [
    'sublocality_level_1',
    'sublocality',
    'neighborhood',
  ], 0, false);
  return cleanNullLiteral(raw);
}
