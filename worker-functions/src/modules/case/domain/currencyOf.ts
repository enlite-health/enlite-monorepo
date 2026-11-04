/**
 * currencyOf — moeda do preço de um contrato (spec 058, plan §1.2). A moeda é decidida pelo PAÍS do contrato (E3.country); o imposto é do
 * termo em qualquer país. Cobre exatamente as chaves do CHECK `insurance_contracts_country_check` (AR, BR): país fora delas LANÇA, nunca
 * inventa uma moeda. A paridade com o CHECK vivo é provada em `tests/e2e/058a-paridade-pais.e2e.test.ts`.
 */
export type Currency = 'ARS' | 'BRL';

const CURRENCY_BY_COUNTRY: Readonly<Record<string, Currency>> = { AR: 'ARS', BR: 'BRL' };

export class UnknownCurrencyCountryError extends Error {
  readonly code = 'UNKNOWN_CURRENCY_COUNTRY';
  constructor(country: string) {
    super(`sem moeda para o país ${JSON.stringify(country)}`);
    this.name = 'UnknownCurrencyCountryError';
  }
}

/** Países que têm moeda (as chaves do CHECK). */
export const CURRENCY_COUNTRIES: readonly string[] = Object.keys(CURRENCY_BY_COUNTRY);

export function currencyOf(country: string): Currency {
  if (!Object.prototype.hasOwnProperty.call(CURRENCY_BY_COUNTRY, country)) throw new UnknownCurrencyCountryError(country);
  return CURRENCY_BY_COUNTRY[country];
}
