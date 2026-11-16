import { logger } from '@shared/logging';
import { isCountryCode } from '@shared/domain/countryCodes';
import { withTimeout } from '@shared/utils/withTimeout';
import { isStaffAccount, type AccountTyped } from '@modules/identity/domain/AccountType';
import type { CountryClaimWrite, ICountryClaimPort } from '../ports/ICountryClaimPort';

/** Orçamento da escrita do claim dentro da resposta do init (o mesmo do `/v1/me/areas`, RECONCILE_TIMEOUT_MS). */
export const COUNTRY_CLAIM_BUDGET_MS = 3_000;

export type CountryClaimOutcome = CountryClaimWrite | 'skipped_staff' | 'skipped_no_country' | 'failed';

export interface ProvisionCountryClaimInput {
  uid: string;
  principal: AccountTyped;
  /** `workers.country` da ficha lida do banco (D731: nunca do corpo). */
  country: unknown;
}

/**
 * D731: o init grava o claim `country` a partir de `workers.country` (dono único, D514), uma vez por login.
 * Staff fica fora: o país do staff é atribuído pelo runbook (`scripts/set-staff-country-claim.ts`, lex C3).
 * Ficha sem país válido não ganha claim: a conta segue fail-closed (D733). Falha ou demora do Firebase não
 * derruba o init: o app cai no 403 `NO_COUNTRY_CLAIM` de antes e a próxima entrada tenta de novo.
 * Logs só com o uid (sem e-mail nem telefone); `country_claim_provisioned` é a trilha do rollback.
 */
export class ProvisionCountryClaimUseCase {
  constructor(
    private readonly claims: ICountryClaimPort,
    private readonly budgetMs: number = COUNTRY_CLAIM_BUDGET_MS,
  ) {}

  async execute(input: ProvisionCountryClaimInput): Promise<CountryClaimOutcome> {
    if (isStaffAccount(input.principal)) return 'skipped_staff';
    if (!isCountryCode(input.country)) {
      logger.warn({ uid: input.uid, reason: 'no_country' }, 'country_claim_skipped');
      return 'skipped_no_country';
    }
    try {
      const write = await withTimeout(this.claims.ensureCountry(input.uid, input.country), this.budgetMs, 'claim country');
      if (write === 'provisioned') logger.info({ uid: input.uid, country: input.country }, 'country_claim_provisioned');
      return write;
    } catch (error) {
      logger.error({ uid: input.uid, error: error instanceof Error ? error.name : 'error' }, 'country_claim_failed');
      return 'failed';
    }
  }
}
