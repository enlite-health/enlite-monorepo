import { CURRENCY_COUNTRIES, UnknownCurrencyCountryError, currencyOf } from '../currencyOf';

describe('currencyOf', () => {
  it('AR -> ARS e BR -> BRL', () => {
    expect(currencyOf('AR')).toBe('ARS');
    expect(currencyOf('BR')).toBe('BRL');
  });

  it('outro país, minúsculo, vazio e chave herdada lançam UnknownCurrencyCountryError', () => {
    for (const c of ['CL', 'ar', '', 'constructor']) expect(() => currencyOf(c)).toThrow(UnknownCurrencyCountryError);
  });

  it('cobre exatamente AR e BR (a paridade com o CHECK do banco está em 058a-paridade-pais.e2e)', () => {
    expect([...CURRENCY_COUNTRIES].sort()).toEqual(['AR', 'BR']);
  });
});
