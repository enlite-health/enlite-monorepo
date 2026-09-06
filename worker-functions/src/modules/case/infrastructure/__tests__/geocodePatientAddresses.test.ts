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

  /**
   * 🔒 O VAZAMENTO DE 06/09/2026.
   *
   * A rede de segurança do ClickUp roda a cada 10 min com janela de 30 — cada
   * card alterado é reprocessado ~3 vezes. A cada passagem, TODO endereço do
   * paciente era geocodificado de novo, mesmo quando o texto não mudou e a
   * coordenada já estava no banco. Medido em produção: 132 chamadas por hora,
   * 24h por dia, inclusive de madrugada, ~95 mil por mês — pagando ao Google
   * para reresponder o que já sabíamos. Franquia: 10 mil/mês.
   */
  describe('coordenada já conhecida (o vazamento de 06/09)', () => {
    it('NÃO chama o Google quando a coordenada já é conhecida', async () => {
      const geocoder = { geocodeBatch: jest.fn() } as unknown as GeocodingService;
      const a = makeAddress({ addressFormatted: 'Av. Corrientes 1234, CABA' });

      const out = await geocodePatientAddressesBestEffort([a], geocoder, {
        known: new Map([['Av. Corrientes 1234, CABA', { lat: -34.6, lng: -58.38 }]]),
      });

      expect(geocoder.geocodeBatch).not.toHaveBeenCalled();
      expect(out).toEqual([{ address: a, lat: -34.6, lng: -58.38 }]);
    });

    it('chama o Google SÓ para o endereço novo, preservando a ordem', async () => {
      // É a metade que impede o conserto de virar "nunca geocodifica": endereço
      // novo ou com texto alterado TEM de continuar sendo resolvido.
      const geocodeBatch = jest.fn(async (_q: string[]) => [{ latitude: -31.4, longitude: -64.18 } as GeocodedAddress]);
      const geocoder = { geocodeBatch } as unknown as GeocodingService;
      const conhecido = makeAddress({ addressFormatted: 'Av. Corrientes 1234, CABA', displayOrder: 1 });
      const novo = makeAddress({ addressFormatted: 'Av. Colón 500, Córdoba', displayOrder: 2 });

      const out = await geocodePatientAddressesBestEffort([conhecido, novo], geocoder, {
        known: new Map([['Av. Corrientes 1234, CABA', { lat: -34.6, lng: -58.38 }]]),
      });

      expect(geocodeBatch).toHaveBeenCalledTimes(1);
      expect(geocodeBatch.mock.calls[0][0]).toEqual(['Av. Colón 500, Córdoba']);
      expect(out[0]).toEqual({ address: conhecido, lat: -34.6, lng: -58.38 });
      expect(out[1]).toEqual({ address: novo, lat: -31.4, lng: -64.18 });
    });

    it('sem o mapa de conhecidos, o comportamento é o de sempre', async () => {
      const geocodeBatch = jest.fn(async () => [{ latitude: -34.6, longitude: -58.38 } as GeocodedAddress]);
      const geocoder = { geocodeBatch } as unknown as GeocodingService;
      const a = makeAddress({ addressFormatted: 'Av. Corrientes 1234, CABA' });

      await geocodePatientAddressesBestEffort([a], geocoder);

      expect(geocodeBatch).toHaveBeenCalledTimes(1);
    });
  });
});
