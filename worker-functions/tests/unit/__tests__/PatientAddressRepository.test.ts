/**
 * PatientAddressRepository.resolveOrCreatePatientAddress — Unit Tests
 *
 * Coverage:
 *   (a) exact match found by address_formatted → returns existing id, no INSERT
 *   (b) no match + addressFormatted present → inserts new row, returns new id
 *   (c) both addressFormatted and addressRaw null → returns null immediately
 *   (d) no formatted address, raw only → tries match on address_raw
 *   (e) no formatted address, raw only, no match → returns null (no INSERT)
 *   (f) constructor: default (no geocoder arg) vs injected geocoder — branch
 *       coverage of `geocoder ?? new GeocodingService()` (lines 18-19)
 *   (g) tryGeocode: geocoder resolves a value vs resolves null — branch
 *       coverage of the ternary in `tryGeocode` (line 96)
 */

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }),
  },
}));

import { PatientAddressRepository } from '../../../src/modules/matching/infrastructure/PatientAddressRepository';

// ── Mock pool ──────────────────────────────────────────────────────────────────

function makeMockPool(responses: unknown[]) {
  let callIndex = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = responses[callIndex++];
      return Promise.resolve(resp);
    }),
  };
}

// Bypass DatabaseConnection singleton by injecting pool directly via prototype
function makeRepo(pool: ReturnType<typeof makeMockPool>): PatientAddressRepository {
  const repo = Object.create(PatientAddressRepository.prototype);
  (repo as any).pool = pool;
  return repo;
}

// ──────────────────────────────────────────────────────────────────────────────

describe('PatientAddressRepository.resolveOrCreatePatientAddress', () => {
  const patientId = 'patient-uuid-001';

  it('(a) exact match found → returns existing id without inserting', async () => {
    const pool = makeMockPool([
      { rows: [{ id: 'pa-existing-001' }] }, // SELECT exact match
    ]);
    const repo = makeRepo(pool);

    const result = await repo.resolveOrCreatePatientAddress({
      patientId,
      addressFormatted: 'Av. Corrientes 1234, Buenos Aires',
      addressRaw: null,
    });

    expect(result).toBe('pa-existing-001');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('(b) no match + addressFormatted present → inserts new row, returns new id', async () => {
    const pool = makeMockPool([
      { rows: [] },                          // SELECT — no match
      { rows: [{ id: 'pa-new-001' }] },      // INSERT
    ]);
    const repo = makeRepo(pool);

    const result = await repo.resolveOrCreatePatientAddress({
      patientId,
      addressFormatted: 'Calle Falsa 123, Rosario',
      addressRaw: 'Falsa 123',
    });

    expect(result).toBe('pa-new-001');
    expect(pool.query).toHaveBeenCalledTimes(2);
    // Second call should be INSERT
    const insertCall = pool.query.mock.calls[1][0] as string;
    expect(insertCall).toMatch(/INSERT INTO patient_addresses/i);
    // Spec 019 (B4): o literal hardcoded 'service' de address_type saiu — a coluna nasce NULL,
    // valor só via PATCH (AdminPatientAddressesController).
    expect(insertCall).not.toMatch(/address_type/);
    expect(insertCall).not.toMatch(/'service'/);
  });

  it('(c) both null → returns null immediately without querying', async () => {
    const pool = makeMockPool([]);
    const repo = makeRepo(pool);

    const result = await repo.resolveOrCreatePatientAddress({
      patientId,
      addressFormatted: null,
      addressRaw: null,
    });

    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('(d) raw only, match found → returns existing id', async () => {
    const pool = makeMockPool([
      { rows: [{ id: 'pa-raw-001' }] }, // SELECT on address_raw
    ]);
    const repo = makeRepo(pool);

    const result = await repo.resolveOrCreatePatientAddress({
      patientId,
      addressFormatted: null,
      addressRaw: 'Hipólito Yrigoyen 500',
    });

    expect(result).toBe('pa-raw-001');
  });

  it('(e) raw only, no match → returns null without inserting', async () => {
    const pool = makeMockPool([
      { rows: [] }, // SELECT on address_raw — no match
    ]);
    const repo = makeRepo(pool);

    const result = await repo.resolveOrCreatePatientAddress({
      patientId,
      addressFormatted: null,
      addressRaw: 'Unknown address',
    });

    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('PatientAddressRepository constructor', () => {
  it('(f1) builds its own GeocodingService when none is injected (default branch)', () => {
    const repo = new PatientAddressRepository();
    expect((repo as any).geocoder).toBeDefined();
    expect((repo as any).pool).toBeDefined();
  });

  it('(f2) uses the injected geocoder instead of building a new one', () => {
    const injected = { geocode: jest.fn() };
    const repo = new PatientAddressRepository(injected as any);
    expect((repo as any).geocoder).toBe(injected);
  });
});

describe('PatientAddressRepository tryGeocode (via resolveOrCreatePatientAddress insert path)', () => {
  const patientId = 'patient-uuid-002';

  it('(g1) geocoder resolves a result → lat/lng from the result are persisted', async () => {
    const pool = makeMockPool([
      { rows: [] },                     // SELECT — no match
      { rows: [{ id: 'pa-geo-001' }] }, // INSERT
    ]);
    const repo = makeRepo(pool);
    (repo as any).geocoder = { geocode: jest.fn().mockResolvedValue({ latitude: -34.6, longitude: -58.4 }) };

    await repo.resolveOrCreatePatientAddress({
      patientId,
      addressFormatted: 'Av. Geocoded 1',
      addressRaw: null,
    });

    const insertParams = pool.query.mock.calls[1][1] as unknown[];
    expect(insertParams).toContain(-34.6);
    expect(insertParams).toContain(-58.4);
  });

  it('(g2) geocoder resolves null (no result found) → lat/lng persisted as null', async () => {
    const pool = makeMockPool([
      { rows: [] },                     // SELECT — no match
      { rows: [{ id: 'pa-geo-002' }] }, // INSERT
    ]);
    const repo = makeRepo(pool);
    (repo as any).geocoder = { geocode: jest.fn().mockResolvedValue(null) };

    await repo.resolveOrCreatePatientAddress({
      patientId,
      addressFormatted: 'Av. Unresolvable',
      addressRaw: null,
    });

    const insertParams = pool.query.mock.calls[1][1] as unknown[];
    expect(insertParams[3]).toBeNull();
    expect(insertParams[4]).toBeNull();
  });
});
