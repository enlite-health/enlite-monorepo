/**
 * contractedServicePriceRead (§P) — preço e imposto do serviço numa data (spec 058 §3.2 §P, plan §1.2).
 *
 * `priceStateMany` lê o vínculo vigente e o termo vigente do contrato numa SQL só (em LOTE, `ANY($1)`), e projeta pelo `termView` do §T.
 * Todo id pedido aparece no Map. `price`: NO_CONTRACT | NO_TERM | OK{hourlyRate, currency} (moeda por `currencyOf` do país do CONTRATO);
 * `tax`: NO_CONTRACT | NO_TERM | OK{taxRatePercent}. `NOT_DEFINED` não existe (o imposto é NOT NULL no termo). O `REDACTED` do preço é
 * só da projeção por ator (`redactTermForActor`); o imposto não é redigido.
 */
import { termRowFromDb, termView, liveTermContainingSql, type Queryable, type TermPrice } from './insuranceContractTermRead';

export type PriceState = { state: 'NO_CONTRACT' } | { state: 'NO_TERM' } | TermPrice;
export type TaxState = { state: 'NO_CONTRACT' } | { state: 'NO_TERM' } | { state: 'OK'; taxRatePercent: number };

export interface ServicePriceTax {
  price: PriceState;
  tax: TaxState;
}

interface PriceDbRow {
  contracted_service_id: string;
  term_id: string | null;
  contract_id: string;
  country: string;
  hourly_rate: string | null;
  tax_rate_percent: string | null;
  valid: string | null;
}

export async function priceStateMany(q: Queryable, serviceIds: readonly string[], asOf: string): Promise<Map<string, ServicePriceTax>> {
  const out = new Map<string, ServicePriceTax>();
  for (const id of serviceIds) out.set(id, { price: { state: 'NO_CONTRACT' }, tax: { state: 'NO_CONTRACT' } });
  if (serviceIds.length === 0) return out;
  const { rows } = await q.query<PriceDbRow>(
    `SELECT csc.contracted_service_id, t.id AS term_id, c.id AS contract_id, c.country,
            t.hourly_rate, t.tax_rate_percent, t.valid::text AS valid
       FROM contracted_service_contract csc
       JOIN insurance_contracts c ON c.id = csc.contract_id
       LEFT JOIN insurance_contract_terms t ON t.contract_id = c.id AND ${liveTermContainingSql('t', '$2')}
      WHERE csc.contracted_service_id = ANY($1::uuid[]) AND csc.superseded_at IS NULL AND csc.valid @> $2::date`,
    [serviceIds, asOf],
  );
  for (const r of rows) {
    const view =
      r.term_id === null
        ? termView(null)
        : termView(
            termRowFromDb({
              id: r.term_id,
              contract_id: r.contract_id,
              country: r.country,
              hourly_rate: r.hourly_rate as string,
              tax_rate_percent: r.tax_rate_percent as string,
              valid: r.valid as string,
            }),
          );
    out.set(
      r.contracted_service_id,
      view.state === 'NO_TERM'
        ? { price: { state: 'NO_TERM' }, tax: { state: 'NO_TERM' } }
        : { price: view.price, tax: { state: 'OK', taxRatePercent: view.taxRatePercent } },
    );
  }
  return out;
}
