/**
 * backfillPatientAddressLocation — Unit Tests
 *
 * Covers the Fase 1 patient-address cleanup backfill decision logic:
 *  - empty-shell rows (address_raw='null' + address_formatted=null) are
 *    identified and MUST be excluded from the candidate set upstream
 *  - address_formatted is fill-only — an existing value is never overwritten
 *  - state/city/neighborhood are re-derived via the same locationHelpers +
 *    argentinaLocationNormalizer used at ClickUp-import time
 *  - lat/lng are only planned when currently null on the row
 *  - geocode failure (null) never produces a plan
 */
import {
  isEmptyShellAddress,
  buildBackfillGeocodingQuery,
  buildBackfillPlan,
  classifyBackfillUnresolved,
  haversineDistanceKm,
  TOO_FAR_KM_THRESHOLD,
  parseExcludeIdsArg,
  buildBackfillCandidatesPredicate,
  type BackfillAddressRow,
} from '../backfillPatientAddressLocation';
import type { GeocodedAddress } from '../../../../infrastructure/services/GeocodingService';

function makeRow(overrides: Partial<BackfillAddressRow> = {}): BackfillAddressRow {
  return {
    id: 'addr-1',
    address_formatted: null,
    address_raw: null,
    state: null,
    city: null,
    neighborhood: null,
    lat: null,
    lng: null,
    ...overrides,
  };
}

function makeGeocode(overrides: Partial<GeocodedAddress> = {}): GeocodedAddress {
  return {
    formattedAddress: 'Av. Chiclana 2856, C1275 CABA, Argentina',
    city: 'CABA',
    state: 'CABA',
    country: 'AR',
    latitude: -34.63,
    longitude: -58.4,
    placeId: 'fake-place-id',
    addressComponents: [
      { long_name: 'Parque Patricios', types: ['sublocality_level_1', 'sublocality'] },
      { long_name: 'CABA', types: ['locality'] },
      { long_name: 'Ciudad Autónoma de Buenos Aires', types: ['administrative_area_level_1'] },
    ],
    ...overrides,
  };
}

describe('isEmptyShellAddress', () => {
  it('identifies a casca vazia (address_raw literal "null" + address_formatted null)', () => {
    expect(isEmptyShellAddress({ address_raw: 'null', address_formatted: null })).toBe(true);
  });

  it('is case-insensitive on the "null" literal', () => {
    expect(isEmptyShellAddress({ address_raw: 'NULL', address_formatted: null })).toBe(true);
  });

  it('is NOT a shell when address_formatted is already set', () => {
    expect(isEmptyShellAddress({ address_raw: 'null', address_formatted: 'Av. X 100' })).toBe(false);
  });

  it('is NOT a shell when address_raw has real content', () => {
    expect(isEmptyShellAddress({ address_raw: 'Av. Chiclana 2856', address_formatted: null })).toBe(false);
  });
});

describe('buildBackfillGeocodingQuery', () => {
  it('prefers address_formatted when present', () => {
    const row = makeRow({ address_formatted: 'Av. X 100, CABA, Argentina', address_raw: 'ignored' });
    expect(buildBackfillGeocodingQuery(row)).toBe('Av. X 100, CABA, Argentina');
  });

  it('falls back to address_raw + context when address_formatted is null', () => {
    const row = makeRow({
      address_raw: 'Av. Chiclana 2856, 4 piso, C',
      city: 'CABA',
      state: 'CABA',
    });
    expect(buildBackfillGeocodingQuery(row)).toBe('Av. Chiclana 2856, 4 piso, C, CABA, CABA, Argentina');
  });
});

describe('buildBackfillPlan', () => {
  it('returns null when geocoding failed (ZERO_RESULTS) — row untouched', () => {
    const row = makeRow({ address_formatted: 'unresolvable address' });
    expect(buildBackfillPlan(row, null)).toBeNull();
  });

  it('never overwrites an existing address_formatted (fill-only)', () => {
    const row = makeRow({
      address_formatted: 'Av. Existente 123, CABA, Argentina',
      state: 'Buenos Aires Province',
    });
    const plan = buildBackfillPlan(row, makeGeocode());
    expect(plan?.updates.address_formatted).toBeUndefined();
    expect(plan?.changes.some((c) => c.field === 'address_formatted')).toBe(false);
  });

  it('fills address_formatted when currently null', () => {
    const row = makeRow({ address_formatted: null, address_raw: 'Av. Chiclana 2856' });
    const plan = buildBackfillPlan(row, makeGeocode());
    expect(plan?.updates.address_formatted).toBe('Av. Chiclana 2856, C1275 CABA, Argentina');
  });

  it('re-derives state through the canonical province normalizer', () => {
    const row = makeRow({ state: 'Ciudad Autónoma de Buenos Aires Dirty' });
    const plan = buildBackfillPlan(row, makeGeocode());
    expect(plan?.updates.state).toBe('CABA');
  });

  it('does not touch state when the newly-derived value matches the stored one', () => {
    const row = makeRow({ state: 'CABA' });
    const plan = buildBackfillPlan(row, makeGeocode());
    expect(plan?.updates.state).toBeUndefined();
    expect(plan?.changes.some((c) => c.field === 'state')).toBe(false);
  });

  it('strips postal-code prefix from city', () => {
    const row = makeRow({ city: 'B1602 Florida' });
    const geocode = makeGeocode({
      addressComponents: [{ long_name: 'B1602 Florida', types: ['locality'] }],
    });
    const plan = buildBackfillPlan(row, geocode);
    expect(plan?.updates.city).toBe('Florida');
  });

  it('REGRESSION (patient_addresses id a06d5086-90cf-422d-ab05-7431b8aed7ea): city cascades to sublocality instead of writing a bare CP', () => {
    // Exact reproduction: row.city already holds the bad "C1126ABC" value
    // from a previous run; the fresh geocode response has NO `locality`
    // component at all, `administrative_area_level_2` is a bare Argentine
    // postal code, and `sublocality_level_1` ("Barrio Norte") is available.
    const row = makeRow({ city: 'C1126ABC' });
    const geocode = makeGeocode({
      addressComponents: [
        { long_name: 'C1126ABC', types: ['administrative_area_level_2'] },
        { long_name: 'Barrio Norte', types: ['sublocality_level_1'] },
      ],
    });
    const plan = buildBackfillPlan(row, geocode);
    expect(plan?.updates.city).toBe('Barrio Norte');
    expect(plan?.changes.some((c) => c.field === 'city' && c.oldValue === 'C1126ABC' && c.newValue === 'Barrio Norte')).toBe(true);
  });

  it('cleans a literal "null" neighborhood even without a fresh component match', () => {
    const row = makeRow({ neighborhood: 'null' });
    const geocode = makeGeocode({ addressComponents: [] });
    const plan = buildBackfillPlan(row, geocode);
    expect(plan?.updates.neighborhood).toBeNull();
    expect(plan?.changes.some((c) => c.field === 'neighborhood' && c.newValue === null)).toBe(true);
  });

  it('sets lat/lng only when currently null on the row', () => {
    const row = makeRow({ lat: null, lng: null });
    const plan = buildBackfillPlan(row, makeGeocode({ latitude: -34.1, longitude: -58.9 }));
    expect(plan?.updates.lat).toBe(-34.1);
    expect(plan?.updates.lng).toBe(-58.9);
  });

  it('never overwrites existing lat/lng (geocode point kept within safety radius so TOO_FAR does not mask this assertion)', () => {
    const row = makeRow({ lat: -34.63, lng: -58.4 });
    // ~300m away from the row's stored point — well inside TOO_FAR_KM_THRESHOLD.
    const plan = buildBackfillPlan(row, makeGeocode({ latitude: -34.632, longitude: -58.401 }));
    expect(plan?.updates.lat).toBeUndefined();
    expect(plan?.updates.lng).toBeUndefined();
    expect(plan?.changes.some((c) => c.field === 'lat' || c.field === 'lng')).toBe(false);
  });

  it('returns null (UNRESOLVED) when the geocode result is Google partial_match — never plans a guessed location', () => {
    const row = makeRow({ address_raw: 'MARTIN GARCIA 2635 (Casa), Argentina' });
    const geocode = makeGeocode({ partialMatch: true });
    expect(buildBackfillPlan(row, geocode)).toBeNull();
  });

  it('returns null (UNRESOLVED) when the geocode result lands >10km from the row\'s existing lat/lng', () => {
    // Row already anchored in CABA; geocode result lands in Misiones — hundreds of km away.
    const row = makeRow({ lat: -34.6, lng: -58.4 });
    const geocode = makeGeocode({ latitude: -27.35, longitude: -55.9 });
    expect(buildBackfillPlan(row, geocode)).toBeNull();
  });
});

describe('haversineDistanceKm', () => {
  it('returns ~0 for the same point', () => {
    expect(haversineDistanceKm(-34.6, -58.4, -34.6, -58.4)).toBeCloseTo(0, 3);
  });

  it('computes a realistic distance for two nearby CABA points (~1km apart)', () => {
    const km = haversineDistanceKm(-34.6037, -58.3816, -34.6137, -58.3816);
    expect(km).toBeGreaterThan(0.9);
    expect(km).toBeLessThan(1.2);
  });

  it('computes a realistic long-range distance (CABA → Salta, ~1150km)', () => {
    const km = haversineDistanceKm(-34.6037, -58.3816, -24.7859, -65.4117);
    expect(km).toBeGreaterThan(1000);
    expect(km).toBeLessThan(1300);
  });
});

describe('classifyBackfillUnresolved', () => {
  it('returns "ZERO_RESULTS" when geocode is null', () => {
    expect(classifyBackfillUnresolved(makeRow(), null)).toBe('ZERO_RESULTS');
  });

  it('returns "PARTIAL_MATCH" when Google flags partialMatch=true', () => {
    const row = makeRow();
    const geocode = makeGeocode({ partialMatch: true });
    expect(classifyBackfillUnresolved(row, geocode)).toBe('PARTIAL_MATCH');
  });

  it('returns null (resolved) when partialMatch is false/absent', () => {
    const row = makeRow();
    expect(classifyBackfillUnresolved(row, makeGeocode({ partialMatch: false }))).toBeNull();
    expect(classifyBackfillUnresolved(row, makeGeocode({ partialMatch: undefined }))).toBeNull();
  });

  it(`returns "TOO_FAR" when row has lat/lng and geocode result is more than ${TOO_FAR_KM_THRESHOLD}km away`, () => {
    const row = makeRow({ lat: -34.6, lng: -58.4 });
    const geocode = makeGeocode({ latitude: -27.35, longitude: -55.9 }); // Misiones
    expect(classifyBackfillUnresolved(row, geocode)).toBe('TOO_FAR');
  });

  it('returns null when row has lat/lng and geocode result is within the safety radius', () => {
    const row = makeRow({ lat: -34.6, lng: -58.4 });
    const geocode = makeGeocode({ latitude: -34.601, longitude: -58.401 });
    expect(classifyBackfillUnresolved(row, geocode)).toBeNull();
  });

  it('skips the distance check entirely when the row has no existing lat/lng', () => {
    const row = makeRow({ lat: null, lng: null });
    const geocode = makeGeocode({ latitude: -27.35, longitude: -55.9 });
    expect(classifyBackfillUnresolved(row, geocode)).toBeNull();
  });
});

describe('parseExcludeIdsArg', () => {
  it('returns an empty array when --exclude-ids is absent', () => {
    expect(parseExcludeIdsArg(['node', 'script.ts', '--apply'])).toEqual([]);
  });

  it('parses a single UUID', () => {
    const argv = ['node', 'script.ts', '--exclude-ids', '4b2ab006-62d8-4cfb-8cbd-b61d17651ce2'];
    expect(parseExcludeIdsArg(argv)).toEqual(['4b2ab006-62d8-4cfb-8cbd-b61d17651ce2']);
  });

  it('parses a comma-separated list, trimming whitespace around each id', () => {
    const argv = [
      'node',
      'script.ts',
      '--exclude-ids',
      ' 4b2ab006-62d8-4cfb-8cbd-b61d17651ce2 , 11111111-1111-1111-1111-111111111111',
    ];
    expect(parseExcludeIdsArg(argv)).toEqual([
      '4b2ab006-62d8-4cfb-8cbd-b61d17651ce2',
      '11111111-1111-1111-1111-111111111111',
    ]);
  });

  it('is case-insensitive on the UUID format (uppercase accepted)', () => {
    const argv = ['node', 'script.ts', '--exclude-ids', '4B2AB006-62D8-4CFB-8CBD-B61D17651CE2'];
    expect(parseExcludeIdsArg(argv)).toEqual(['4B2AB006-62D8-4CFB-8CBD-B61D17651CE2']);
  });

  it('throws a fatal error listing every invalid UUID when --exclude-ids has malformed entries', () => {
    const argv = ['node', 'script.ts', '--exclude-ids', 'not-a-uuid,4b2ab006-62d8-4cfb-8cbd-b61d17651ce2,123'];
    expect(() => parseExcludeIdsArg(argv)).toThrow(/not-a-uuid/);
    expect(() => parseExcludeIdsArg(argv)).toThrow(/123/);
    // The valid id in the middle must NOT be silently dropped from the error —
    // operator needs to see exactly what's wrong without re-deriving it.
    expect(() => parseExcludeIdsArg(argv)).not.toThrow(/4b2ab006-62d8-4cfb-8cbd-b61d17651ce2 is invalid/);
  });

  it('throws when --exclude-ids is passed with no value', () => {
    const argv = ['node', 'script.ts', '--exclude-ids'];
    expect(() => parseExcludeIdsArg(argv)).toThrow();
  });

  it('throws when --exclude-ids value is only whitespace/empty entries', () => {
    const argv = ['node', 'script.ts', '--exclude-ids', ' , ,'];
    expect(() => parseExcludeIdsArg(argv)).toThrow();
  });
});

describe('buildBackfillCandidatesPredicate', () => {
  it('default (includeArchivedReferenced=false): only active rows, no EXISTS/job_postings clause', () => {
    const predicate = buildBackfillCandidatesPredicate({ includeArchivedReferenced: false });
    expect(predicate).toMatch(/archived_at IS NULL/);
    expect(predicate).not.toMatch(/EXISTS/);
    expect(predicate).not.toMatch(/job_postings/);
  });

  it('includeArchivedReferenced=true: widens to archived rows referenced by a non-deleted job_posting', () => {
    const predicate = buildBackfillCandidatesPredicate({ includeArchivedReferenced: true });
    expect(predicate).toMatch(/archived_at IS NULL/);
    expect(predicate).toMatch(/EXISTS/);
    expect(predicate).toMatch(/job_postings/);
    expect(predicate).toMatch(/patient_address_id/);
    expect(predicate).toMatch(/jp\.deleted_at IS NULL/);
    expect(predicate).toMatch(/archived_at IS NOT NULL|OR EXISTS/);
  });

  it('both variants ALWAYS exclude empty-shell rows regardless of the flag', () => {
    const withoutFlag = buildBackfillCandidatesPredicate({ includeArchivedReferenced: false });
    const withFlag = buildBackfillCandidatesPredicate({ includeArchivedReferenced: true });
    const shellClause = /address_formatted IS NULL[\s\S]*lower\(trim\(coalesce\(address_raw, ''\)\)\) = 'null'/;
    expect(withoutFlag).toMatch(shellClause);
    expect(withFlag).toMatch(shellClause);
  });

  it('is valid, parenthesis-balanced SQL text (defensive smoke check — no DB call)', () => {
    for (const includeArchivedReferenced of [false, true]) {
      const predicate = buildBackfillCandidatesPredicate({ includeArchivedReferenced });
      const opens = (predicate.match(/\(/g) ?? []).length;
      const closes = (predicate.match(/\)/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});
