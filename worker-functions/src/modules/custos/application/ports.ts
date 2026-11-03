import type { BillingData, BillingWindow } from '../domain/types';

/** Porta de leitura do faturamento (DF-3: fonte única = billing export; sem cópia no Postgres). */
export interface BillingReader {
  /** Lança `BillingReadError` (`billing_query_failed` | `bytes_limit`); nunca repassa texto cru do erro. */
  read(window: BillingWindow): Promise<BillingData>;
}
