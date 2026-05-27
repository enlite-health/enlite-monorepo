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
 */

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
 */
function extractAddressComponent(
  location: unknown,
  componentTypes: string[],
  segmentIndex: 0 | -1 = 0,
  allowFormattedFallback: boolean = true,
): string | null {
  if (!location || typeof location !== 'object') return null;
  const loc = location as Record<string, unknown>;

  // Try structured address_components first (preferred)
  if (Array.isArray(loc['address_components'])) {
    const components = loc['address_components'] as Array<Record<string, unknown>>;
    for (const comp of components) {
      const types = comp['types'];
      if (!Array.isArray(types)) continue;
      const hasType = componentTypes.some(t => (types as string[]).includes(t));
      if (hasType) {
        const name = comp['long_name'] ?? comp['short_name'];
        if (typeof name === 'string' && name.trim()) return name.trim();
      }
    }
  }

  if (!allowFormattedFallback) return null;

  // Fallback: parse formatted_address by comma segments
  // e.g. "Buenos Aires, CABA, Argentina" → segments ["Buenos Aires","CABA","Argentina"]
  if (typeof loc['formatted_address'] === 'string') {
    const segments = loc['formatted_address']
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (segments.length === 0) return null;
    const idx = segmentIndex === -1 ? Math.max(0, segments.length - 2) : segmentIndex;
    return segments[idx] ?? null;
  }

  return null;
}

/**
 * Extracts the state (provincia) from a ClickUp location field value.
 * Uses address_components type "administrative_area_level_1".
 * Falls back to first comma segment of formatted_address (safe for
 * patient-level fields like "Provincia del Paciente" that hold "Santa Fe"
 * directly). Returns null when not extractable.
 */
export function extractStateFromLocation(location: unknown): string | null {
  return extractAddressComponent(location, ['administrative_area_level_1'], 0, true);
}

/**
 * Strict variant of extractStateFromLocation — uses ONLY address_components,
 * never falls back to parsing formatted_address by comma. Use when the location
 * is a full street address (e.g. `Domicilio N Principal Paciente`), where the
 * first comma segment is the street, not the state.
 */
export function extractStateFromLocationStrict(location: unknown): string | null {
  return extractAddressComponent(location, ['administrative_area_level_1'], 0, false);
}

/**
 * Extracts the city (ciudad / localidad) from a ClickUp location field value.
 * Tries locality, then sublocality_level_1, then administrative_area_level_2.
 * Falls back to first comma segment of formatted_address.
 * Returns null when not extractable.
 */
export function extractCityFromLocation(location: unknown): string | null {
  return extractAddressComponent(location, [
    'locality',
    'sublocality_level_1',
    'administrative_area_level_2',
  ], 0, true);
}

/**
 * Strict variant of extractCityFromLocation — uses ONLY address_components.
 * Use with full street addresses.
 */
export function extractCityFromLocationStrict(location: unknown): string | null {
  return extractAddressComponent(location, [
    'locality',
    'sublocality_level_1',
    'administrative_area_level_2',
  ], 0, false);
}

/**
 * Normalizes a neighborhood (zona/barrio) string from a ClickUp short_text field.
 * Simply trims whitespace and returns null for empty/null values.
 */
export function extractNeighborhood(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Extracts the neighborhood (barrio / sublocalidade) from a ClickUp location field value.
 * Tries sublocality_level_1, then sublocality, then neighborhood.
 *
 * Used to keep neighborhood in sync with address_formatted when the operator
 * updates only "Domicilio Principal" in ClickUp (the location field with
 * address_components). The legacy `Zona o Barrio Paciente` short_text field is
 * then used as a fallback when the location field does not provide structured
 * components — see ClickUpPatientMapper.buildAddresses.
 */
export function extractNeighborhoodFromLocation(location: unknown): string | null {
  // Strict: neighborhood from location MUST come from address_components.
  // Formatted_address fallback would yield the street name (first segment),
  // which is wrong. Use the legacy `Zona o Barrio Paciente` short_text field
  // as fallback in the mapper instead.
  return extractAddressComponent(location, [
    'sublocality_level_1',
    'sublocality',
    'neighborhood',
  ], 0, false);
}
