/**
 * summarizeAddress
 *
 * Receives a full address string (typically `patient_addresses.address_formatted`,
 * coming from Google Places) and returns a short locality-level summary suitable
 * for display as informational context (e.g. "Tigre, Provincia de Buenos Aires"
 * or "Consolação, São Paulo - SP").
 *
 * Heuristics:
 *  - drops the leading street segment(s) (street name + number, AR or BR style)
 *  - drops the trailing country (Argentina/Brasil/etc.)
 *  - strips Argentinian postal prefixes (B1648EEU) and Brazilian CEP (01305-100)
 *
 * Pure function — no DOM, no I/O. Returns '' when input is empty.
 */

const STREET_PREFIX_RE =
  /^(?:rua|r\.|av\.?|avenida|calle|cl\.|plaza|pl\.|diagonal|camino|pje\.|pasaje|ruta|estrada|travessa|tv\.|alameda|al\.|boulevard|bd\.)(?=\s|$)/i;

const COUNTRIES = new Set([
  'argentina',
  'brasil',
  'brazil',
  'uruguay',
  'chile',
  'paraguay',
  'bolivia',
  'peru',
]);

const AR_POSTAL_PREFIX_RE = /^[A-Z]\d{4}[A-Z]*\s+/;
const BR_CEP_RE = /\b\d{5}-?\d{3}\b/g;

export function summarizeAddress(formatted: string | null | undefined): string {
  const input = (formatted ?? '').trim();
  if (!input) return '';

  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';

  let i = 0;
  // Drop leading street segment(s).
  // Case A — single segment "Av. Italia 736" (AR): matches STREET_PREFIX or ends with " <number>".
  // Case B — two segments "Rua Augusta", "975" (BR): first matches STREET_PREFIX, second is pure number.
  const startsWithStreet =
    STREET_PREFIX_RE.test(parts[i]) || /\s\d+\s*$/.test(parts[i]);
  if (startsWithStreet) {
    i += 1;
    if (i < parts.length && /^\d+(?:-\d+)?$/.test(parts[i])) {
      i += 1;
    }
  }

  let result = parts.slice(i);

  // Drop trailing country.
  if (
    result.length > 1 &&
    COUNTRIES.has(result[result.length - 1].toLowerCase())
  ) {
    result = result.slice(0, -1);
  }

  // Strip postal codes (AR prefix on the locality, BR CEP anywhere).
  result = result
    .map((s) => s.replace(AR_POSTAL_PREFIX_RE, ''))
    .map((s) => s.replace(BR_CEP_RE, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return result.join(', ');
}
