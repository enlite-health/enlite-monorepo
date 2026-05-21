import { countryToTimezone } from '../CountryTimezone';

describe('countryToTimezone', () => {
  it('retorna timezone correto para AR', () => {
    expect(countryToTimezone('AR')).toBe('America/Argentina/Buenos_Aires');
  });

  it('retorna timezone correto para BR', () => {
    expect(countryToTimezone('BR')).toBe('America/Sao_Paulo');
  });

  it('retorna UTC para país desconhecido', () => {
    expect(countryToTimezone('XX')).toBe('UTC');
  });

  it('retorna UTC para string vazia', () => {
    expect(countryToTimezone('')).toBe('UTC');
  });

  it('é case-sensitive (minúsculo não mapeia)', () => {
    expect(countryToTimezone('ar')).toBe('UTC');
    expect(countryToTimezone('br')).toBe('UTC');
  });
});
