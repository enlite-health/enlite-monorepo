import type { AnomalyDetailRow, BillingData, BillingWindow, DetailRange } from '../domain/types';

/** Porta de leitura do faturamento (DF-3: fonte única = billing export; sem cópia no Postgres). */
export interface BillingReader {
  /** Lança `BillingReadError` (`billing_query_failed` | `bytes_limit`); nunca repassa texto cru do erro. */
  read(window: BillingWindow): Promise<BillingData>;
  /**
   * Custo líquido por dia x recurso dos `services` na janela (spec §15). Roda DEPOIS de `read()` e só com >= 1 serviço anômalo.
   * Mesmos erros de `read()`; estourar `DETAIL_QUERY_ROW_CAP` linhas também é erro (nunca truncamento silencioso).
   */
  readAnomalyDetail(range: DetailRange, services: string[]): Promise<AnomalyDetailRow[]>;
}
