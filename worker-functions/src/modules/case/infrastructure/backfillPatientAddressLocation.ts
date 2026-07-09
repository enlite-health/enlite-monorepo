/**
 * backfillPatientAddressLocation — pure decision logic for the Fase 1
 * `patient_addresses` cleanup backfill (out-of-band script, see
 * `scripts/backfill-patient-addresses-location.ts`).
 *
 * Kept as pure functions (no DB, no HTTP) so the decision logic is unit
 * testable with a mocked Geocoding result — following
 * feedback_modularize_to_extreme (utils never write to DB) and reusing the
 * SAME extraction/normalization functions used at ClickUp-import time
 * (locationHelpers + argentinaLocationNormalizer), so backfilled rows and
 * newly-synced rows never diverge.
 */
// NOTE: deep import (not the `@modules/integration` barrel) is deliberate —
// requiring the full integration barrel through `ts-node -r
// tsconfig-paths/register` (how this file's consumer script runs) transitively
// reaches an UNRELATED pre-existing type error in
// modules/matching/interfaces/controllers/WJAContactNotesController.ts
// (ts-node's lazy compilation doesn't load the global Express.Request
// augmentation unless a file is reached that needs it — a ts-node/tsconfig
// gotcha, not a real bug in that controller; `tsc --noEmit` on the full
// project is clean). The barrel export was still added for `tsc`-compiled
// consumers. See Fase 1 endereços handoff notes for the reproduction.
import {
  extractStateFromLocationStrict,
  extractCityFromLocationStrict,
  extractNeighborhoodFromLocation,
} from '../../integration/infrastructure/clickup/helpers/locationHelpers';
import { cleanNullLiteral } from '@shared/utils/argentinaLocationNormalizer';
import { buildGeocodingQuery } from './geocodePatientAddresses';
import type { GeocodedAddress } from '../../../infrastructure/services/GeocodingService';
import type { PatientAddress } from '../../../infrastructure/repositories/PatientRepository';

/** Row shape read from `patient_addresses` for the backfill candidate set. */
export interface BackfillAddressRow {
  id: string;
  address_formatted: string | null;
  address_raw: string | null;
  state: string | null;
  city: string | null;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
}

export interface FieldChange {
  field: 'address_formatted' | 'state' | 'city' | 'neighborhood' | 'lat' | 'lng';
  oldValue: unknown;
  newValue: unknown;
}

export interface BackfillPlan {
  id: string;
  changes: FieldChange[];
  updates: {
    address_formatted?: string;
    state?: string | null;
    city?: string | null;
    neighborhood?: string | null;
    lat?: number;
    lng?: number;
  };
}

/** Safety-radius threshold (km) — see `classifyBackfillUnresolved` TOO_FAR. */
export const TOO_FAR_KM_THRESHOLD = 10;

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two lat/lng points, in kilometers. */
export function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/** Reason a candidate row was left untouched by the backfill (unresolved). */
export type UnresolvedReason = 'ZERO_RESULTS' | 'PARTIAL_MATCH' | 'TOO_FAR';

/**
 * Two safety nets on top of the raw geocode result, found by manual
 * dry-run review against prod (Fase 1 follow-up):
 *
 *  - PARTIAL_MATCH: Google had to relax part of the query to find ANY
 *    match (e.g. street number dropped, or wrong street matched). Seen in
 *    prod on raw-only addresses with no city ("MARTIN GARCIA 2635 (Casa)"
 *    guessed a Salta street with the same name/number). Never trust a
 *    partial match to write a location automatically.
 *  - TOO_FAR: when the row already has a trusted lat/lng (from a previous
 *    geocode or import), a new result landing more than
 *    `TOO_FAR_KM_THRESHOLD` km away is more likely a wrong match than a
 *    correction (seen in prod: a CABA address geocoded into Misiones
 *    because the free-text raw string accidentally matched a street name
 *    that also exists there).
 *
 * Returns null when the result is safe to apply.
 */
export function classifyBackfillUnresolved(
  row: Pick<BackfillAddressRow, 'lat' | 'lng'>,
  geocode: GeocodedAddress | null,
): UnresolvedReason | null {
  if (!geocode) return 'ZERO_RESULTS';
  if (geocode.partialMatch === true) return 'PARTIAL_MATCH';

  if (row.lat !== null && row.lng !== null) {
    const distanceKm = haversineDistanceKm(row.lat, row.lng, geocode.latitude, geocode.longitude);
    if (distanceKm > TOO_FAR_KM_THRESHOLD) return 'TOO_FAR';
  }

  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses the `--exclude-ids <uuid,uuid,...>` CLI flag. Rows whose id is in
 * this list are skipped BEFORE any geocoding call (manual-review rows found
 * during dry-run, e.g. a wrong prior geocode that dodges both PARTIAL_MATCH
 * and TOO_FAR — see Fase 1 endereços handoff).
 *
 * Throws (fatal, caller must exit before connecting to the DB) when:
 *  - the flag is present but has no value, or
 *  - any comma-separated entry is not a valid UUID (empty entries from
 *    trailing/duplicate commas count as invalid — silently ignoring a typo
 *    would defeat the point of an explicit manual-review exclusion list).
 *
 * Returns an empty array when the flag is absent.
 */
export function parseExcludeIdsArg(argv: readonly string[]): string[] {
  const idx = argv.indexOf('--exclude-ids');
  if (idx === -1) return [];

  const raw = argv[idx + 1];
  if (!raw) {
    throw new Error('--exclude-ids requires a value (comma-separated list of UUIDs).');
  }

  const ids = raw.split(',').map((s) => s.trim());
  const invalid = ids.filter((id) => !UUID_RE.test(id));
  if (invalid.length > 0) {
    throw new Error(
      `--exclude-ids contains invalid UUID(s): ${invalid.map((v) => JSON.stringify(v)).join(', ')}`,
    );
  }

  return ids;
}

/**
 * "Casca vazia" — address_raw is the literal string "null" AND
 * address_formatted is NULL. These rows carry no real address data and are
 * intentionally EXCLUDED from the backfill (product decision — do not touch).
 */
export function isEmptyShellAddress(
  row: Pick<BackfillAddressRow, 'address_raw' | 'address_formatted'>,
): boolean {
  return (
    row.address_formatted === null &&
    (row.address_raw ?? '').trim().toLowerCase() === 'null'
  );
}

/** Options for `buildBackfillCandidatesPredicate`. */
export interface BackfillCandidateSelectionOptions {
  /** See `buildBackfillCandidatesPredicate` for the full rationale. */
  includeArchivedReferenced: boolean;
}

/**
 * Builds the SQL WHERE predicate (text to follow the `WHERE` keyword) for
 * selecting `patient_addresses` backfill candidates. Kept as a pure string
 * builder — no DB connection — so the two branches are unit-testable
 * without a live Postgres.
 *
 * Default (`includeArchivedReferenced: false`): only active rows
 * (`archived_at IS NULL`) — the original Fase 1 scope.
 *
 * `includeArchivedReferenced: true`: ALSO includes ARCHIVED rows that are
 * still referenced by a non-deleted `job_postings.patient_address_id`
 * (migration 198 versioning freezes the address version a vacancy points
 * to at creation time). Found in prod: 231 non-deleted job_postings point
 * to archived address versions still carrying dirty `state`/`city` — a scan
 * limited to `archived_at IS NULL` never touches them, and
 * `PublicJobsController`'s JOIN exposes that dirt on the public site.
 *
 * Empty-shell rows (`address_raw` literal "null" + `address_formatted`
 * NULL) are EXCLUDED regardless of the flag — product decision, never
 * touch them (see `isEmptyShellAddress`, applied again in JS as a
 * belt-and-suspenders filter after the SELECT).
 */
export function buildBackfillCandidatesPredicate(
  opts: BackfillCandidateSelectionOptions,
): string {
  const archivedClause = opts.includeArchivedReferenced
    ? `(
      archived_at IS NULL
      OR EXISTS (
        SELECT 1 FROM job_postings jp
         WHERE jp.patient_address_id = patient_addresses.id
           AND jp.deleted_at IS NULL
      )
    )`
    : 'archived_at IS NULL';

  return `${archivedClause}
    AND NOT (
      address_formatted IS NULL
      AND lower(trim(coalesce(address_raw, ''))) = 'null'
    )`;
}

/**
 * Builds the geocoding query string for a candidate row — reuses
 * `buildGeocodingQuery` (the same function used in the online upsert path)
 * so the "prefer formatted, else raw+context" strategy never diverges
 * between write-path and backfill.
 */
export function buildBackfillGeocodingQuery(row: BackfillAddressRow, country = 'AR'): string | null {
  const asPatientAddress: PatientAddress = {
    addressType: 'primary',
    displayOrder: 1,
    addressFormatted: row.address_formatted,
    addressRaw: row.address_raw,
    state: row.state,
    city: row.city,
    neighborhood: row.neighborhood,
  };
  return buildGeocodingQuery(asPatientAddress, country);
}

/**
 * Computes the UPDATE plan for a single row given a (possibly null, when
 * geocoding failed/ZERO_RESULTS) `GeocodedAddress`. Returns null when
 * geocoding failed OR when `classifyBackfillUnresolved` flags the result as
 * unsafe (PARTIAL_MATCH / TOO_FAR) — caller logs it as unresolved and does
 * not touch the row.
 *
 * Rules (Fase 1 spec):
 *  - `address_formatted` is FILL-ONLY — never overwritten when already set.
 *  - `state`/`city`/`neighborhood` are re-derived from the geocoder's
 *    address_components via the SAME extractors used at import time, and
 *    only included in the plan when they differ from the stored value
 *    (avoids no-op writes and keeps the dry-run report meaningful).
 *  - `lat`/`lng` are set ONLY when currently null on the row.
 *  - A Google `partial_match` or a result landing more than
 *    `TOO_FAR_KM_THRESHOLD` from an existing trusted lat/lng is NEVER
 *    applied — see `classifyBackfillUnresolved`.
 */
export function buildBackfillPlan(
  row: BackfillAddressRow,
  geocode: GeocodedAddress | null,
): BackfillPlan | null {
  if (classifyBackfillUnresolved(row, geocode) !== null) return null;
  if (!geocode) return null; // unreachable (classify already returns ZERO_RESULTS above) — kept for type narrowing

  const location = {
    formatted_address: geocode.formattedAddress,
    address_components: geocode.addressComponents ?? [],
  };

  const newState        = extractStateFromLocationStrict(location);
  const newCity          = extractCityFromLocationStrict(location);
  const newNeighborhood  = extractNeighborhoodFromLocation(location) ?? cleanNullLiteral(row.neighborhood);

  const changes: FieldChange[] = [];
  const updates: BackfillPlan['updates'] = {};

  if (!row.address_formatted) {
    updates.address_formatted = geocode.formattedAddress;
    changes.push({ field: 'address_formatted', oldValue: row.address_formatted, newValue: geocode.formattedAddress });
  }

  if (newState !== null && newState !== row.state) {
    updates.state = newState;
    changes.push({ field: 'state', oldValue: row.state, newValue: newState });
  }

  if (newCity !== null && newCity !== row.city) {
    updates.city = newCity;
    changes.push({ field: 'city', oldValue: row.city, newValue: newCity });
  }

  if (newNeighborhood !== (row.neighborhood ?? null)) {
    updates.neighborhood = newNeighborhood;
    changes.push({ field: 'neighborhood', oldValue: row.neighborhood, newValue: newNeighborhood });
  }

  const hasCoords = row.lat !== null && row.lng !== null;
  if (!hasCoords) {
    updates.lat = geocode.latitude;
    updates.lng = geocode.longitude;
    changes.push({ field: 'lat', oldValue: row.lat, newValue: geocode.latitude });
    changes.push({ field: 'lng', oldValue: row.lng, newValue: geocode.longitude });
  }

  return { id: row.id, changes, updates };
}
