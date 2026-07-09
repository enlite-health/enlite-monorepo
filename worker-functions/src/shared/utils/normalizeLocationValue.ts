/**
 * normalizeLocationValue — SSOT for provincia/localidad normalization on the
 * admin "Prestadores" (worker list) filter.
 *
 * WHY THIS EXISTS
 * The `worker_service_areas.city` / `.state` columns hold RAW strings from two
 * eras: the app flow (Google Places → clean "Buenos Aires", "Lanús") and legacy
 * imports whose "city" got the 3-letter suffix of the Argentine CPA postal code
 * (e.g. address "Carlos Pellegrini 1676, B1748 AEJ, ..." → city="AEJ"). Those
 * codes (AEJ/AOO/ARP/BSI/GTJ …) polluted the Localidad dropdown.
 *
 * Additionally the CABA signal (the AC's example) is NOT in `city`/`state` at
 * all — it lives as free text in `work_zone` ("CABA") and `interest_zone`
 * ("En CABA…", "Capital federal"). So a `city ILIKE 'CABA'` filter returned 0.
 *
 * This module is the single normalization point used by BOTH:
 *   1. the dropdown builder (getFilterOptions) — `canonicalLocation` cleans junk
 *      and folds CABA aliases to one canonical label;
 *   2. the WHERE-clause builder — `resolveLocationFilter` expands a selected
 *      value into the set of lowercased equality keys + free-text `ILIKE`
 *      patterns to match, so CABA finds the ~150 workers whose CABA signal only
 *      lives in the zone columns.
 *
 * Normalization is QUERY-TIME (no stored column / no migration): the dropdown is
 * populated from the same rows, so lower(btrim(col)) round-trips accents/case
 * without needing the `unaccent` extension. The alias expansion lives ONLY here
 * (SSOT) — SQL just does lower(btrim(...)). A durable Google-geocoded backfill of
 * the free-text zones into structured provincia/localidad is a separate,
 * human-gated follow-up (see GeocodingService.geocodeBatch).
 */

/** A group of raw values that all denote the same canonical location. */
interface AliasGroup {
  /** Canonical display label shown in the dropdown. */
  label: string;
  /** Lowercased equality keys (matched against lower(btrim(city|state|work_zone))). */
  keys: string[];
  /**
   * Lowercased substring fragments matched via ILIKE against the free-text zone
   * columns (work_zone / interest_zone). Non-empty only for zones that commonly
   * appear inside sentences (CABA). Kept conservative to avoid false positives.
   */
  contains: string[];
}

const CABA_CANONICAL = 'Ciudad Autónoma de Buenos Aires';

const ALIAS_GROUPS: readonly AliasGroup[] = [
  {
    label: CABA_CANONICAL,
    keys: [
      'ciudad autónoma de buenos aires',
      'ciudad autonoma de buenos aires',
      'cdad. autónoma de buenos aires',
      'cdad autonoma de buenos aires',
      'ciudad de buenos aires',
      'capital federal',
      'capital',
      'caba',
      'c.a.b.a.',
    ],
    contains: ['caba', 'capital federal', 'capital fed', 'ciudad autónoma', 'ciudad autonoma'],
  },
];

/** Trim + collapse internal whitespace. */
function tidy(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/\s+/g, ' ');
}

/** Lowercased normalization key (accents preserved — round-trips with the DB). */
function toKey(raw: string | null | undefined): string {
  return tidy(raw).toLowerCase();
}

function findGroup(raw: string | null | undefined): AliasGroup | null {
  const key = toKey(raw);
  if (key === '') return null;
  return ALIAS_GROUPS.find((g) => g.keys.includes(key) || toKey(g.label) === key) ?? null;
}

/**
 * True when a raw location string is junk that must never reach the dropdown:
 *   - empty / whitespace only;
 *   - a 3-uppercase-letter Argentine CPA postal suffix (AEJ, BSI, …);
 *   - a full CPA code (letter + 4 digits + 3 letters, e.g. "B1748 AEJ");
 *   - a pure-numeric token.
 * Recognized aliases (CABA) are handled before this check by the caller.
 */
export function isJunkLocation(raw: string | null | undefined): boolean {
  const t = tidy(raw);
  if (t === '') return true;
  if (/^[A-Z]{3}$/.test(t)) return true;
  if (/^[A-Z]\d{4}\s?[A-Z]{3}$/.test(t)) return true;
  if (/^\d+$/.test(t)) return true;
  return false;
}

/**
 * Canonical display value for the dropdown, or null when the raw value is junk
 * or a free-text zone sentence (commas / very long). Recognized aliases fold to
 * their canonical label; clean localities are returned tidied (DB casing kept).
 */
export function canonicalLocation(raw: string | null | undefined): string | null {
  const t = tidy(raw);
  if (t === '') return null;

  const group = findGroup(t);
  if (group) return group.label;

  if (isJunkLocation(t)) return null;
  // Free-text zone lists ("Paternal, Villa Crespo, …") or long sentences are not
  // a single locality — exclude from the dropdown.
  if (t.includes(',') || t.length > 40) return null;

  return t;
}

/**
 * Canonical label IF the raw value is a recognized zone alias (e.g. work_zone
 * "CABA" → "Ciudad Autónoma de Buenos Aires"), else null. Used to surface CABA
 * into the dropdown from the free-text `work_zone` column WITHOUT admitting other
 * free-text zone strings.
 */
export function recognizedZoneLabel(raw: string | null | undefined): string | null {
  return findGroup(raw)?.label ?? null;
}

/** What the WHERE builder needs to match a selected provincia/localidad value. */
export interface LocationFilterMatch {
  /** Lowercased equality keys for lower(btrim(city|state|work_zone)) = ANY(...). */
  exactKeys: string[];
  /** Lowercased substring patterns for ILIKE ANY(...) on work_zone / interest_zone. */
  containsPatterns: string[];
}

/**
 * Expands a selected filter value (a canonical label or any alias) into the
 * equality keys + free-text patterns to match. Plain localities yield a single
 * lowercased key and no patterns; CABA yields its whole alias set + patterns so
 * rows whose CABA signal only lives in work_zone/interest_zone are found.
 */
export function resolveLocationFilter(raw: string | null | undefined): LocationFilterMatch {
  const t = tidy(raw);
  if (t === '') return { exactKeys: [], containsPatterns: [] };

  const group = findGroup(t);
  if (group) {
    return { exactKeys: [...group.keys], containsPatterns: [...group.contains] };
  }
  return { exactKeys: [toKey(t)], containsPatterns: [] };
}

const PBA_CANONICAL = 'Provincia de Buenos Aires';

/**
 * Canonicaliza o rótulo de provincia (`state`) para uma forma única em espanhol.
 * O Google Maps devolve a mesma provincia com nomes inconsistentes ("Buenos
 * Aires Province" em inglês, "Buenos Aires" cru, "Córdoba Province"), o que
 * fragmenta o dropdown/analytics. Regras:
 *   - CABA (várias grafias)                         → "Ciudad Autónoma de Buenos Aires"
 *   - "Buenos Aires" cru: desambigua pela localidad → city="Buenos Aires" é a
 *     CIDADE (CABA); qualquer outra localidad é a PROVINCIA (PBA)
 *   - "Buenos Aires Province" / "Provincia de …"    → "Provincia de Buenos Aires"
 *   - inglês "<X> Province"                          → "<X>" (Córdoba, Entre Ríos, …)
 *   - resto                                          → inalterado
 */
export function canonicalProvince(
  state: string | null | undefined,
  city?: string | null,
): string | null {
  if (state === null || state === undefined) return state ?? null;
  const s = state.trim();
  if (s === '') return s;
  const low = s.toLowerCase();

  if (['ciudad autónoma de buenos aires', 'ciudad autonoma de buenos aires', 'caba', 'capital federal'].includes(low)) {
    return CABA_CANONICAL;
  }
  if (low === 'buenos aires') {
    return (city ?? '').trim().toLowerCase() === 'buenos aires' ? CABA_CANONICAL : PBA_CANONICAL;
  }
  if (low === 'buenos aires province' || low === 'provincia de buenos aires') {
    return PBA_CANONICAL;
  }
  const m = s.match(/^(.*) Province$/i);
  if (m) return m[1].trim();
  return s;
}
