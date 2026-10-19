/**
 * contractedServicePayerRead (§G) — quem é o PAGADOR de cada serviço contratado numa data (spec 058 §3.2 §G/§D, plan §1.2).
 *
 * Duas leituras em LOTE (uma SQL cada, `contracted_service_id = ANY($1)`, só vivas) e uma função pura:
 *  - `payerAtMany`      o vínculo vigente em `asOf`. TODO id pedido aparece no Map: sem vínculo = `NO_CONTRACT`, nunca ausente
 *                       (um buraco no Map viraria `undefined` na tela, que seria lido como "ainda carregando").
 *  - `payerHistoryMany` as linhas vivas do vínculo (vigentes, futuras e fechadas). Lista vazia = "nenhum vínculo válido".
 *  - `derivePayerCoverageMatch` §D: pagador do serviço x coberturas verificadas do paciente -> 1 de 6 estados.
 *
 * Os `names` saem COMPLETOS (inclui `payerKind`): a redação por célula `coverage` é só de `projectContractedServiceForActor`. Os leitores
 * não recebem o ator. Vigência no fio via `dateRangeWire` (`validTo` inclusivo). A data é parâmetro: nenhum "hoje" no SQL (D-43).
 */
import { toWire } from '../domain/dateRangeWire';
import type { Queryable } from './insuranceContractTermRead';

export type PayerKind = 'OBRA_SOCIAL' | 'PREPAGA' | 'PRIVATE';

export interface PayerNames {
  providerCode: string;
  providerName: string;
  contractId: string;
  contractName: string;
  payerKind: PayerKind | null;
}

/** Pagador vigente. `names: null` só existe DEPOIS da redação (a leitura sempre devolve completo). */
export type Payer =
  | { state: 'NO_CONTRACT' }
  | { state: 'LINKED'; isPrivate: boolean; validFrom: string; validTo: string | null; names: PayerNames | null };

export interface PayerHistoryItem {
  linkId: string;
  isPrivate: boolean;
  validFrom: string;
  validTo: string | null;
  names: PayerNames | null;
}

/** Um vínculo lido do banco, sempre com `names` completos. */
export type PayerRead = { state: 'NO_CONTRACT' } | (Extract<Payer, { state: 'LINKED' }> & { names: PayerNames });
export type PayerHistoryItemRead = PayerHistoryItem & { names: PayerNames };

interface LinkDbRow {
  link_id: string;
  contracted_service_id: string;
  valid: string;
  contract_id: string;
  contract_name: string;
  provider_code: string;
  provider_name: string;
  payer_kind: PayerKind | null;
}

const LINK_FROM_SQL = `
  FROM contracted_service_contract csc
  JOIN insurance_contracts c ON c.id = csc.contract_id
  JOIN insurance_providers p ON p.code = c.provider_code`;

const LINK_COLUMNS_SQL = `
  csc.id AS link_id, csc.contracted_service_id, csc.valid::text AS valid,
  c.id AS contract_id, c.name AS contract_name, p.code AS provider_code, p.name AS provider_name, p.payer_kind`;

function namesOf(r: LinkDbRow): PayerNames {
  return { providerCode: r.provider_code, providerName: r.provider_name, contractId: r.contract_id, contractName: r.contract_name, payerKind: r.payer_kind };
}

/** Pagador vigente em `asOf` de cada serviço, em LOTE. Todo id de `serviceIds` aparece no Map (`NO_CONTRACT` por padrão). */
export async function payerAtMany(q: Queryable, serviceIds: readonly string[], asOf: string): Promise<Map<string, PayerRead>> {
  const out = new Map<string, PayerRead>();
  for (const id of serviceIds) out.set(id, { state: 'NO_CONTRACT' });
  if (serviceIds.length === 0) return out;
  const { rows } = await q.query<LinkDbRow>(
    `SELECT ${LINK_COLUMNS_SQL}
       ${LINK_FROM_SQL}
      WHERE csc.contracted_service_id = ANY($1::uuid[]) AND csc.superseded_at IS NULL AND csc.valid @> $2::date`,
    [serviceIds, asOf],
  );
  for (const r of rows) {
    const w = toWire(r.valid);
    out.set(r.contracted_service_id, {
      state: 'LINKED',
      isPrivate: r.payer_kind === 'PRIVATE',
      validFrom: w.validFrom,
      validTo: w.validTo,
      names: namesOf(r),
    });
  }
  return out;
}

/** Linhas VIVAS do vínculo de cada serviço, em LOTE, da mais antiga para a mais nova. Todo id aparece (lista vazia = nenhum vínculo válido). */
export async function payerHistoryMany(q: Queryable, serviceIds: readonly string[]): Promise<Map<string, PayerHistoryItemRead[]>> {
  const out = new Map<string, PayerHistoryItemRead[]>();
  for (const id of serviceIds) out.set(id, []);
  if (serviceIds.length === 0) return out;
  const { rows } = await q.query<LinkDbRow>(
    `SELECT ${LINK_COLUMNS_SQL}
       ${LINK_FROM_SQL}
      WHERE csc.contracted_service_id = ANY($1::uuid[]) AND csc.superseded_at IS NULL
      ORDER BY csc.contracted_service_id, csc.valid`,
    [serviceIds],
  );
  for (const r of rows) {
    const w = toWire(r.valid);
    out.get(r.contracted_service_id)?.push({
      linkId: r.link_id,
      isPrivate: r.payer_kind === 'PRIVATE',
      validFrom: w.validFrom,
      validTo: w.validTo,
      names: namesOf(r),
    });
  }
  return out;
}

/** Cobertura verificada do paciente como o §C a monta (`patientCoverageRead`): `mapped:false` = rótulo sem código no catálogo. */
export interface CoverageEntryLike {
  code: string | null;
  mapped: boolean;
}

/**
 * Os 6 estados do §D (a spec fixa o NÚMERO; os nomes e a ordem de decisão são do arquiteto, ver progresso da 058a):
 *  NO_PAYER        serviço sem vínculo vigente -> não há o que comparar
 *  PRIVATE_PAYER   pagador particular -> cobertura verificada não se aplica
 *  NO_COVERAGE     há pagador, mas o paciente não tem nenhuma cobertura verificada
 *  UNMAPPED_ONLY   só há coberturas sem mapeamento -> não dá para comparar
 *  MATCH           alguma cobertura verificada mapeada é a obra social do pagador
 *  MISMATCH        há coberturas mapeadas e nenhuma é a do pagador (o aviso de divergência)
 */
export type PayerCoverageMatchState = 'NO_PAYER' | 'PRIVATE_PAYER' | 'NO_COVERAGE' | 'UNMAPPED_ONLY' | 'MATCH' | 'MISMATCH';

/** O `coverageMatch` do fio: `{ state }` como `payer` e `price`; `REDACTED` (sem a célula `coverage`) é posto só pela projeção. */
export interface PayerCoverageMatch {
  state: PayerCoverageMatchState;
}

export function derivePayerCoverageMatch(payer: PayerRead, entries: readonly CoverageEntryLike[]): PayerCoverageMatch {
  if (payer.state === 'NO_CONTRACT') return { state: 'NO_PAYER' };
  if (payer.isPrivate) return { state: 'PRIVATE_PAYER' };
  if (entries.length === 0) return { state: 'NO_COVERAGE' };
  const mapped = entries.filter((e) => e.mapped && e.code !== null);
  if (mapped.length === 0) return { state: 'UNMAPPED_ONLY' };
  return { state: mapped.some((e) => e.code === payer.names.providerCode) ? 'MATCH' : 'MISMATCH' };
}

/**
 * O item de um Map em LOTE para `id`. Os leitores garantem uma chave por id pedido ("lote sem buraco"); se faltar, é defeito de quem
 * leu e vira ERRO, nunca um `NO_CONTRACT` inventado — o chamador não preenche buraco com plausibilidade.
 */
export function batchEntry<T>(map: ReadonlyMap<string, T>, id: string): T {
  const v = map.get(id);
  if (v === undefined) throw new Error(`leitura em lote sem entrada para o id ${id}`);
  return v;
}
