/**
 * InsuranceContract — contrato e termos de valor da obra social, como o FIO os entrega (spec 058 Parte A, §3.2 §W/§T).
 * Mirrors `AdminInsuranceContractsController.contractItem` + `termView` (worker-functions/src/modules/case).
 *
 * Regras do fio que o front NÃO reinterpreta:
 *  - `asOf` vem da resposta (dia de operação do país do contrato) — o front nunca calcula "hoje".
 *  - Vigência = `{ validFrom, validTo | null }`, `validTo` INCLUSIVO; datas `YYYY-MM-DD`.
 *  - `price` é `{ state: 'OK', hourlyRate, currency }` ou `{ state: 'REDACTED' }` (sem `patient_contract_value:read`); o imposto nunca é redigido.
 *  - O imposto é obrigatório no termo: `0` = isento (não existe default nem "não definido").
 */
import { z } from 'zod';

/** Tipo do pagador (`insurance_providers.payer_kind`). `PRIVATE` = particular. */
export const PAYER_KINDS = ['OBRA_SOCIAL', 'PREPAGA', 'PRIVATE'] as const;
export type PayerKind = (typeof PAYER_KINDS)[number];

export const CONTRACT_COUNTRIES = ['AR', 'BR'] as const;
export type ContractCountry = (typeof CONTRACT_COUNTRIES)[number];

export const CURRENCIES = ['ARS', 'BRL'] as const;
export type Currency = (typeof CURRENCIES)[number];

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const termPriceSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('OK'), hourlyRate: z.number(), currency: z.enum(CURRENCIES) }).strict(),
  z.object({ state: z.literal('REDACTED') }).strict(),
]);
export type TermPrice = z.infer<typeof termPriceSchema>;

export const contractTermViewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('NO_TERM') }).strict(),
  z
    .object({
      state: z.literal('OK'),
      termId: z.string(),
      validFrom: calendarDate,
      validTo: calendarDate.nullable(),
      taxRatePercent: z.number(),
      price: termPriceSchema,
    })
    .strict(),
]);
export type ContractTermView = z.infer<typeof contractTermViewSchema>;

export const insuranceContractItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    country: z.enum(CONTRACT_COUNTRIES),
    scopeDescription: z.string().nullable(),
    asOf: calendarDate,
    currentTerm: contractTermViewSchema,
    futureTerms: z.array(contractTermViewSchema),
  })
  .strict();
export type InsuranceContractItem = z.infer<typeof insuranceContractItemSchema>;

export const insuranceContractListSchema = z.object({ items: z.array(insuranceContractItemSchema) }).strict();

/** Corpo de um termo de valor. `taxRatePercent` é OBRIGATÓRIO (0 = isento); o formulário nasce vazio. */
export interface InsuranceTermBody {
  hourlyRate: number;
  taxRatePercent: number;
  validFrom: string;
  validTo?: string | null;
}

/** `POST /insurance-providers/:code/contracts` — contrato + 1º termo. */
export interface CreateInsuranceContractBody {
  name: string;
  country: ContractCountry;
  scopeDescription?: string | null;
  firstTerm: InsuranceTermBody;
}

/** `PATCH /insurance-contracts/:id` — só nome e escopo (país e obra social são imutáveis). */
export interface PatchInsuranceContractBody {
  name?: string;
  scopeDescription?: string | null;
}

export type SupersedeTermReason = 'REPRICED' | 'CORRECTION';

/** `POST /insurance-contracts/:id/terms/:termId/supersede` — `validTo` ausente herda o fim do termo substituído. */
export interface SupersedeInsuranceTermBody extends InsuranceTermBody {
  reason: SupersedeTermReason;
}
