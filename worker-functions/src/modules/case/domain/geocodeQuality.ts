/**
 * geocodeQuality — spec 077, F1: o geocoder devolve a QUALIDADE do ponto, e só ROOFTOP / RANGE_INTERPOLATED sem
 * `partial_match` é confiável (RELIABLE) para o check-in por geofence. Função pura, sem import.
 */
export type GeocodeLocationType =
  | 'ROOFTOP'
  | 'RANGE_INTERPOLATED'
  | 'GEOMETRIC_CENTER'
  | 'APPROXIMATE'
  | 'UNKNOWN';

export function isReliableGeocode(
  locationType: GeocodeLocationType | null | undefined,
  partialMatch: boolean | null | undefined,
): boolean {
  if (locationType == null) return false;
  switch (locationType) {
    case 'ROOFTOP':
    case 'RANGE_INTERPOLATED':
      return partialMatch !== true;
    case 'GEOMETRIC_CENTER':
    case 'APPROXIMATE':
    case 'UNKNOWN':
      return false;
    default: {
      const _exhaustive: never = locationType;
      return _exhaustive;
    }
  }
}

export function geocodeQualityLabel(
  locationType: GeocodeLocationType | null | undefined,
  partialMatch: boolean | null | undefined,
): 'RELIABLE' | 'UNRELIABLE' {
  return isReliableGeocode(locationType, partialMatch) ? 'RELIABLE' : 'UNRELIABLE';
}

/**
 * D718 (spec 077, 15/11/2026): no Ponto do MVP, a coordenada de geocode APROXIMADO (rua, bairro ou `partial_match`) COM lat/lng
 * vale como RELIABLE: o gate de raio protege. `null` = "ainda não classificado" (migration 582, linhas 11-13: anterior ao backfill
 * ou geocode falhou), NÃO é aproximado: segue UNRELIABLE até o backfill classificar. `isReliableGeocode` (a régua estrita) fica
 * para o raio diferenciado pós-MVP.
 */
export function isCheckinReliable(locationType: GeocodeLocationType | null | undefined): boolean {
  return locationType != null;
}
