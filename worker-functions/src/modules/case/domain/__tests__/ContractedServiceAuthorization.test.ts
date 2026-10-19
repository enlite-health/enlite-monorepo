import {
  exclusiveUpperOf,
  inclusiveValidToOf,
  AuthorizationOverlapsError,
  AuthorizationNotFoundError,
} from '../ContractedServiceAuthorization';

describe('ContractedServiceAuthorization', () => {
  it('validTo inclusivo → upper exclusivo (+1 dia), atravessando mês e ano', () => {
    expect(exclusiveUpperOf('2026-12-31')).toBe('2027-01-01');
    expect(exclusiveUpperOf('2028-02-28')).toBe('2028-02-29');
  });

  it('upper exclusivo → validTo inclusivo (−1 dia) e a ida-e-volta é identidade', () => {
    expect(inclusiveValidToOf('2027-01-01')).toBe('2026-12-31');
    expect(inclusiveValidToOf(exclusiveUpperOf('2026-03-31'))).toBe('2026-03-31');
  });

  it('data fora do formato ISO é recusada', () => {
    expect(() => exclusiveUpperOf('31/12/2026')).toThrow();
  });

  it('erros de domínio carregam o code da API', () => {
    expect(new AuthorizationOverlapsError().code).toBe('AUTHORIZATION_OVERLAPS');
    expect(new AuthorizationNotFoundError().code).toBe('AUTHORIZATION_NOT_FOUND');
  });
});
