/**
 * createPatientSchema — country is required (abac-pais-fase1 task 5.1).
 *
 * The admin create path used to hardcode country:'AR' at the use-case edge, so a
 * BR patient created from the panel was persisted as AR: invisible in
 * BR-filtered views and filed under the wrong legal regime (Ley 25.326 vs LGPD).
 * The spec country-isolation ("Criação sem país é rejeitada") requires the
 * operation to fail VISIBLY instead of falling back to a silent default — this
 * schema is the enforcement point, mirroring publicLeadSchema.country (D108/F0).
 *
 * Covers:
 *  a. Missing country → rejected (no default applied)
 *  b. Invalid country → rejected, with no silent coercion
 *  c. AR / BR → accepted and preserved verbatim
 *  d. The rest of the contract is unchanged (firstName still required)
 */

import { createPatientSchema } from '../createPatientSchema';

const validBody = { firstName: 'Juan', country: 'AR' };

describe('createPatientSchema — country', () => {
  // ── a. Missing ─────────────────────────────────────────────────────────────
  it('a. rejects a body with no country instead of defaulting to AR', () => {
    const result = createPatientSchema.safeParse({ firstName: 'Juan' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.flatten().fieldErrors.country).toEqual([
      'country is required and must be one of AR, BR',
    ]);
  });

  it('a2. does not silently inject a country when the field is absent', () => {
    const result = createPatientSchema.safeParse({ firstName: 'Juan' });
    // The regression being guarded: parsing must NOT succeed with country='AR'.
    expect(result.success).toBe(false);
  });

  // ── b. Invalid ─────────────────────────────────────────────────────────────
  it.each([['UY'], ['ar'], ['ARG'], ['']])(
    'b. rejects the unsupported country %p with no coercion',
    (country) => {
      const result = createPatientSchema.safeParse({ firstName: 'Juan', country });
      expect(result.success).toBe(false);
    },
  );

  it('b2. rejects a non-string country', () => {
    expect(createPatientSchema.safeParse({ firstName: 'Juan', country: 1 }).success).toBe(false);
    expect(createPatientSchema.safeParse({ firstName: 'Juan', country: null }).success).toBe(false);
  });

  // ── c. Accepted values ─────────────────────────────────────────────────────
  it.each([['AR'], ['BR']])('c. accepts %p and preserves it verbatim', (country) => {
    const result = createPatientSchema.safeParse({ firstName: 'Juan', country });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.country).toBe(country);
  });

  it('c2. accepts a full body with country and keeps the other fields', () => {
    const result = createPatientSchema.safeParse({
      firstName: 'João',
      lastName: 'Silva',
      country: 'BR',
      contactEmail: 'joao@example.com',
      documentType: 'CPF',
      serviceType: ['CAREGIVER'],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toMatchObject({
      firstName: 'João',
      country: 'BR',
      contactEmail: 'joao@example.com',
    });
  });

  // ── d. Rest of the contract unchanged ──────────────────────────────────────
  it('d. still rejects a missing firstName even when country is valid', () => {
    const result = createPatientSchema.safeParse({ country: 'AR' });
    expect(result.success).toBe(false);
  });

  it('d2. still accepts the minimal body (firstName + country only)', () => {
    expect(createPatientSchema.safeParse(validBody).success).toBe(true);
  });
});
