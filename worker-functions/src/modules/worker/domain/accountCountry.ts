import { isCountryCode, type CountryCode } from '@shared/domain/countryCodes';

/** País de uma conta que ainda não tem ficha quando nenhuma região válida chega (D733). */
export const DEFAULT_ACCOUNT_COUNTRY: CountryCode = 'AR';

/**
 * D733: o país da conta NOVA vem da região do navegador (web) ou do aparelho (app), só na criação da ficha.
 * AR|BR (CHECK `valid_country`, migration 002) passa; qualquer outro valor vira AR. Depois de criada, o dono é
 * `workers.country` (D514) e o corpo nunca mais o reescreve.
 */
export function accountCountryOf(region: unknown): CountryCode {
  const code = typeof region === 'string' ? region.trim().toUpperCase() : '';
  return isCountryCode(code) ? code : DEFAULT_ACCOUNT_COUNTRY;
}
