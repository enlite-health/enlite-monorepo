/**
 * PatientAddressRepository.resolveOrCreatePatientAddress — Unit Tests
 *
 * Coverage:
 *   (a) exact match found by address_formatted → returns existing id, no INSERT
 *   (b) no match + addressFormatted present → inserts new row, returns new id
 *   (c) both addressFormatted and addressRaw null → returns null immediately
 *   (d) no formatted address, raw only → tries match on address_raw
 *   (e) no formatted address, raw only, no match → returns null (no INSERT)
 */

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
