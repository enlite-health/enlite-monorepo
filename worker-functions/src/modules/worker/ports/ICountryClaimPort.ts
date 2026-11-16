/** `already_set`: o login já tinha o claim `country` (nada foi escrito). */
export type CountryClaimWrite = 'provisioned' | 'already_set';

/**
 * Claim `country` do login (D731). O adapter grava só quando falta e preserva os demais claims
 * (`role`, `account_type`, `pid`, `areas`): `setCustomUserClaims` substitui o objeto inteiro.
 */
export interface ICountryClaimPort {
  ensureCountry(uid: string, country: string): Promise<CountryClaimWrite>;
}
