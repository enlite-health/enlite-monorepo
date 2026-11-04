import { authorizationBodySchema } from '../contractedServiceAuthorizationSchemas';

const OK = { hours: 120, validFrom: '2026-01-01', validTo: '2026-12-31' };

describe('authorizationBodySchema', () => {
  it('corpo válido passa; validTo = validFrom (um dia) passa; validTo null passa (o 422 é do controller)', () => {
    expect(authorizationBodySchema.safeParse(OK).success).toBe(true);
    expect(authorizationBodySchema.safeParse({ ...OK, validTo: '2026-01-01' }).success).toBe(true);
    expect(authorizationBodySchema.safeParse({ ...OK, validTo: null }).success).toBe(true);
  });

  it('validTo < validFrom → falha', () => {
    expect(authorizationBodySchema.safeParse({ ...OK, validTo: '2025-12-31' }).success).toBe(false);
  });

  it('hours 0 (ou negativo, ou acima do teto) → falha', () => {
    expect(authorizationBodySchema.safeParse({ ...OK, hours: 0 }).success).toBe(false);
    expect(authorizationBodySchema.safeParse({ ...OK, hours: -5 }).success).toBe(false);
    expect(authorizationBodySchema.safeParse({ ...OK, hours: 100001 }).success).toBe(false);
  });

  it('chave extra → falha (strict)', () => {
    expect(authorizationBodySchema.safeParse({ ...OK, country: 'AR' }).success).toBe(false);
  });

  it('data fora do formato → falha', () => {
    expect(authorizationBodySchema.safeParse({ ...OK, validFrom: '01/01/2026' }).success).toBe(false);
  });
});
