/**
 * insuranceContractTermRead (§T) — leitor único dos TERMOS (valor-hora + imposto, com vigência) de um contrato da obra social
 * (spec 058 §3.2 §T, plan §1.2). Só linhas vivas (`superseded_at IS NULL`); a data vem SEMPRE por parâmetro (`asOf`, AAAA-MM-DD, de
 * `shared/locale/operationDate.ts`) — nenhum "hoje" no SQL (D-43). Não recebe ator: a redação do preço é de `redactTermForActor`.
 *
 * "Oferecido" (padrão do plan): contrato com ao menos 1 termo vivo cuja vigência alcança `asOf` ou o futuro (`upper` infinito ou > asOf);
 * contrato cujos termos todos já venceram não aparece na cascata. A conversão daterange <-> wire é de `dateRangeWire.ts`.
 */
import type { Pool } from 'pg';
import { currencyOf, type Currency } from '../domain/currencyOf';
import { toWire } from '../domain/dateRangeWire';

export type Queryable = Pick<Pool, 'query'>;

export interface TermRow {
  termId: string;
  contractId: string;
  country: string;
  hourlyRate: number;
  taxRatePercent: number;
  validFrom: string;
  validTo: string | null;
}

export interface OfferedContract {
  id: string;
  name: string;
  country: string;
  scopeDescription: string | null;
}

/** Valor do preço quando há termo vigente (a redação por ator troca este objeto por `{ state: 'REDACTED' }`). */
export interface TermPrice {
  state: 'OK';
  hourlyRate: number;
  currency: Currency;
}

/** `currentTerm` da lista de contratos: `NO_TERM` | `OK { termId, validFrom, validTo|null, taxRatePercent, price }`. */
export type TermView =
  | { state: 'NO_TERM' }
  | { state: 'OK'; termId: string; validFrom: string; validTo: string | null; taxRatePercent: number; price: TermPrice };

export interface ContractTerms {
  /** O termo vivo que contém `asOf` (`null` = sem termo vigente hoje). */
  current: TermRow | null;
  /** Termos vivos que começam depois de `asOf`, em ordem de início. */
  future: TermRow[];
}

/** Predicado único do "termo vivo que contém a data": `alias` da tabela de termos, `param` = `$n` da data (AAAA-MM-DD). */
export function liveTermContainingSql(alias: string, param: string): string {
  return `${alias}.superseded_at IS NULL AND ${alias}.valid @> ${param}::date`;
}

interface TermDbRow {
  id: string;
  contract_id: string;
  country: string;
  hourly_rate: string;
  tax_rate_percent: string;
  valid: string;
}

/** Linha do banco (colunas `id, contract_id, country, hourly_rate, tax_rate_percent, valid::text AS valid`) -> TermRow. */
export function termRowFromDb(r: TermDbRow): TermRow {
  const w = toWire(r.valid);
  return {
    termId: r.id,
    contractId: r.contract_id,
    country: r.country,
    hourlyRate: Number(r.hourly_rate),
    taxRatePercent: Number(r.tax_rate_percent),
    validFrom: w.validFrom,
    validTo: w.validTo,
  };
}

export const TERM_COLUMNS_SQL = `t.id, t.contract_id, c.country, t.hourly_rate, t.tax_rate_percent, t.valid::text AS valid`;

/** O termo vivo de UM contrato que contém `asOf`, ou `null`. */
export async function termAt(q: Queryable, contractId: string, asOf: string): Promise<TermRow | null> {
  const { rows } = await q.query<TermDbRow>(
    `SELECT ${TERM_COLUMNS_SQL}
       FROM insurance_contract_terms t
       JOIN insurance_contracts c ON c.id = t.contract_id
      WHERE t.contract_id = $1 AND ${liveTermContainingSql('t', '$2')}`,
    [contractId, asOf],
  );
  return rows.length === 0 ? null : termRowFromDb(rows[0]);
}

/** Termo vigente + termos futuros de cada contrato, em LOTE (uma SQL). Todo id pedido aparece no Map. */
export async function termsOfContracts(q: Queryable, contractIds: readonly string[], asOf: string): Promise<Map<string, ContractTerms>> {
  const out = new Map<string, ContractTerms>();
  for (const id of contractIds) out.set(id, { current: null, future: [] });
  if (contractIds.length === 0) return out;
  const { rows } = await q.query<TermDbRow>(
    `SELECT ${TERM_COLUMNS_SQL}
       FROM insurance_contract_terms t
       JOIN insurance_contracts c ON c.id = t.contract_id
      WHERE t.contract_id = ANY($1::uuid[]) AND t.superseded_at IS NULL AND t.valid && daterange($2::date, NULL)
      ORDER BY t.contract_id, t.valid`,
    [contractIds, asOf],
  );
  for (const r of rows) {
    const bucket = out.get(r.contract_id);
    if (!bucket) continue;
    const term = termRowFromDb(r);
    if (term.validFrom <= asOf) bucket.current = term;
    else bucket.future.push(term);
  }
  return out;
}

/** Contratos "oferecidos" do pagador no país: ao menos 1 termo vivo vigente ou futuro (ver cabeçalho). */
export async function offeredContractsOf(q: Queryable, providerCode: string, country: string, asOf: string): Promise<OfferedContract[]> {
  const { rows } = await q.query<{ id: string; name: string; country: string; scope_description: string | null }>(
    `SELECT c.id, c.name, c.country, c.scope_description
       FROM insurance_contracts c
      WHERE c.provider_code = $1 AND c.country = $2
        AND EXISTS (SELECT 1 FROM insurance_contract_terms t
                     WHERE t.contract_id = c.id AND t.superseded_at IS NULL AND t.valid && daterange($3::date, NULL))
      ORDER BY lower(c.name), c.id`,
    [providerCode, country, asOf],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, country: r.country, scopeDescription: r.scope_description }));
}

/** Quantos termos vivos começam depois de `asOf`, por contrato, em LOTE. Todo id pedido aparece (0 = nenhum). */
export async function countFutureTerms(q: Queryable, contractIds: readonly string[], asOf: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of contractIds) out.set(id, 0);
  if (contractIds.length === 0) return out;
  const { rows } = await q.query<{ contract_id: string; n: string }>(
    `SELECT t.contract_id, count(*)::text AS n
       FROM insurance_contract_terms t
      WHERE t.contract_id = ANY($1::uuid[]) AND t.superseded_at IS NULL
        AND t.valid && daterange($2::date, NULL) AND NOT (t.valid @> $2::date)
      GROUP BY t.contract_id`,
    [contractIds, asOf],
  );
  for (const r of rows) out.set(r.contract_id, Number(r.n));
  return out;
}

/** Projeção PURA e completa (sem ator) de um termo: `null` = `NO_TERM`. A moeda vem do país do CONTRATO (`currencyOf`). */
export function termView(term: TermRow | null): TermView {
  if (term === null) return { state: 'NO_TERM' };
  return {
    state: 'OK',
    termId: term.termId,
    validFrom: term.validFrom,
    validTo: term.validTo,
    taxRatePercent: term.taxRatePercent,
    price: { state: 'OK', hourlyRate: term.hourlyRate, currency: currencyOf(term.country) },
  };
}
