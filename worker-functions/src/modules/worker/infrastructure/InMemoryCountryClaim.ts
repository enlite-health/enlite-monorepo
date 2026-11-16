import type { CountryClaimWrite, ICountryClaimPort } from '../ports/ICountryClaimPort';

/**
 * Claim `country` em memória, só para `USE_MOCK_AUTH=true` (e2e sem Identity Platform). Mesma regra do adapter real:
 * claim já posto nunca é trocado. Não alcança o Firebase: no CI o host do emulador não existe e cada init gastava o
 * orçamento inteiro de 3 s esperando um DNS que não responde (suítes de init de 1,3 s para 7-22 s, PR #875).
 */
export class InMemoryCountryClaim implements ICountryClaimPort {
  readonly claims = new Map<string, string>();

  async ensureCountry(uid: string, country: string): Promise<CountryClaimWrite> {
    if (this.claims.has(uid)) return 'already_set';
    this.claims.set(uid, country);
    return 'provisioned';
  }
}
