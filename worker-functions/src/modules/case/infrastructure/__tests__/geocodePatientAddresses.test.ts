/**
 * geocodePatientAddresses — Unit tests
 *
 * Validates the best-effort wrapper around GeocodingService:
 *   - never throws on geocoder failure
 *   - returns lat/lng=null for unresolved entries
 *   - preserves input ordering
 *   - skips entries without any address text
 *   - falls back to address_raw + locality when address_formatted is empty
 */

import {
  buildGeocodingQuery,
  geocodePatientAddressesBestEffort,
} from '../geocodePatientAddresses';
import type { PatientAddress } from '../../../../infrastructure/repositories/PatientRepository';
import type { GeocodingService, GeocodedAddress } from '../../../../infrastructure/services/GeocodingService';

function makeAddress(overrides: Partial<PatientAddress> = {}): PatientAddress {
  return {
    addressType: 'primary',
    addressFormatted: null,
    addressRaw: null,
    displayOrder: 1,
    state: null,
    city: null,
    neighborhood: null,
    ...overrides,
  } as PatientAddress;
}

function fakeGeoResult(lat: number, lng: number): GeocodedAddress {
  return {
    formattedAddress: 'fake',
    city: null,
    state: null,
    country: 'AR',
    latitude: lat,
    longitude: lng,
    placeId: 'fake',
  };
}

function makeGeocoder(
  results: (GeocodedAddress | null)[] | Error,
): GeocodingService {
  return {
    geocodeBatch: jest.fn().mockImplementation(async () => {
      if (results instanceof Error) throw results;
      return results;
    }),
    geocode: jest.fn(),
  } as unknown as GeocodingService;
}

describe('buildGeocodingQuery', () => {
  it('prefers addressFormatted when present', () => {
    expect(
      buildGeocodingQuery(makeAddress({ addressFormatted: 'Av. X 100, CABA' })),
    ).toBe('Av. X 100, CABA');
  });

  it('falls back to addressRaw with locality + country', () => {
    expect(
      buildGeocodingQuery(
        makeAddress({
          addressRaw: 'Bolivia 4145',
          neighborhood: 'Caseros',
          city: 'Tres de Febrero',
          state: 'Buenos Aires',
        }),
      ),
    ).toBe('Bolivia 4145, Caseros, Tres de Febrero, Buenos Aires, Argentina');
  });

  it('returns null when neither formatted nor raw is present', () => {
    expect(buildGeocodingQuery(makeAddress({}))).toBeNull();
  });
});

describe('geocodePatientAddressesBestEffort', () => {
  it('returns empty array for empty input', async () => {
    const geocoder = makeGeocoder([]);
    const out = await geocodePatientAddressesBestEffort([], geocoder);
    expect(out).toEqual([]);
    expect(geocoder.geocodeBatch).not.toHaveBeenCalled();
  });

  it('returns lat/lng=null for entries without address text', async () => {
    const geocoder = makeGeocoder([]);
    const out = await geocodePatientAddressesBestEffort(
      [makeAddress({}), makeAddress({})],
      geocoder,
    );
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.lat === null && r.lng === null)).toBe(true);
    expect(geocoder.geocodeBatch).not.toHaveBeenCalled();
  });

  it('maps results back to original input order', async () => {
    const geocoder = makeGeocoder([
      fakeGeoResult(-34.6, -58.4),
      fakeGeoResult(-23.5, -46.6),
    ]);
    const out = await geocodePatientAddressesBestEffort(
      [
        makeAddress({ addressFormatted: 'A' }),
        makeAddress({ addressFormatted: 'B' }),
      ],
      geocoder,
    );
    expect(out[0].lat).toBe(-34.6);
    expect(out[1].lat).toBe(-23.5);
  });

  it('preserves alignment when some entries have no query (skipped)', async () => {
    const geocoder = makeGeocoder([fakeGeoResult(-34.6, -58.4)]);
    const out = await geocodePatientAddressesBestEffort(
      [
        makeAddress({}),
        makeAddress({ addressFormatted: 'A' }),
        makeAddress({}),
      ],
      geocoder,
    );
    expect(out[0].lat).toBeNull();
    expect(out[1].lat).toBe(-34.6);
    expect(out[2].lat).toBeNull();
  });

  it('returns lat/lng=null for everyone when geocoder throws', async () => {
    const geocoder = makeGeocoder(new Error('OVER_QUERY_LIMIT'));
    const out = await geocodePatientAddressesBestEffort(
      [makeAddress({ addressFormatted: 'A' })],
      geocoder,
    );
    expect(out[0].lat).toBeNull();
    expect(out[0].lng).toBeNull();
  });

  it('returns lat/lng=null when batch resolves null for that index', async () => {
    const geocoder = makeGeocoder([null]);
    const out = await geocodePatientAddressesBestEffort(
      [makeAddress({ addressFormatted: 'unparsable' })],
      geocoder,
    );
    expect(out[0].lat).toBeNull();
    expect(out[0].lng).toBeNull();
  });

  it('respects timeoutMs — abandons batch and returns null when geocoder hangs', async () => {
    const slowGeocoder = {
      geocodeBatch: jest.fn().mockImplementation(
        () => new Promise(() => undefined),
      ),
      geocode: jest.fn(),
    } as unknown as GeocodingService;

    const out = await geocodePatientAddressesBestEffort(
      [makeAddress({ addressFormatted: 'A' })],
      slowGeocoder,
      { timeoutMs: 50 },
    );
    expect(out[0].lat).toBeNull();
    expect(out[0].lng).toBeNull();
  });
});
