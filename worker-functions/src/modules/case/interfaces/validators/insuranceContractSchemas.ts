import { z } from 'zod';

const nonBlank = (max: number) => z.string().trim().min(1).max(max);

/** `AAAA-MM-DD` de calendário REAL (2026-02-31 não passa: o Postgres recusaria o `daterange` com 22008 e viraria 500). */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, { message: 'invalid calendar date' });

/** Valor-hora: > 0, até 2 casas (NUMERIC(12,2)). */
const hourlyRate = z.number().positive().max(9_999_999_999.99).multipleOf(0.01);
/** Imposto em %: OBRIGATÓRIO, sem DEFAULT (vazio = erro; "isento" = digitar 0), 0..100 com até 2 casas (NUMERIC(5,2)). */
const taxRatePercent = z.number().min(0).max(100).multipleOf(0.01);

const rangeOrdered = (v: { validFrom: string; validTo?: string | null }): boolean =>
  v.validTo === undefined || v.validTo === null || v.validTo >= v.validFrom;
const rangeMessage = { message: 'validTo before validFrom', path: ['validTo'] };

/** Termo (valor-hora + imposto + vigência). `validTo` ausente/null = sem fim; `validTo` é INCLUSIVO (último dia vigente, via `dateRangeWire`). */
export const termBodySchema = z
  .object({
    hourlyRate,
    taxRatePercent,
    validFrom: isoDate,
    validTo: isoDate.nullable().optional(),
  })
  .strict()
  .refine(rangeOrdered, rangeMessage);

/** POST /insurance-providers/:code/contracts — contrato com o 1º termo na mesma transação. */
export const createContractBodySchema = z
  .object({
    name: nonBlank(200),
    country: z.enum(['AR', 'BR']),
    scopeDescription: nonBlank(500).nullable().optional(),
    firstTerm: termBodySchema,
  })
  .strict();

/** PATCH /insurance-contracts/:id — só `name` e `scopeDescription`; país e pagador são imutáveis (tratados no controller como 422). */
export const patchContractBodySchema = z
  .object({
    name: nonBlank(200).optional(),
    scopeDescription: nonBlank(500).nullable().optional(),
  })
  .strict();

/** Chaves que o PATCH recusa por serem imutáveis (422 `IMMUTABLE_FIELD`). */
export const IMMUTABLE_CONTRACT_KEYS = ['country', 'providerCode', 'provider_code'] as const;

/** POST /insurance-contracts/:id/terms/:termId/supersede — `REPRICED` (a partir de `validFrom`) ou `CORRECTION` (substitui o termo). */
export const supersedeTermBodySchema = z
  .object({
    reason: z.enum(['REPRICED', 'CORRECTION']),
    hourlyRate,
    taxRatePercent,
    validFrom: isoDate,
    /** Ausente = herda o fim do termo substituído; `null` = sem fim. */
    validTo: isoDate.nullable().optional(),
  })
  .strict()
  .refine(rangeOrdered, rangeMessage);

export const contractIdParamSchema = z.object({ id: z.string().uuid() });
export const termParamsSchema = z.object({ id: z.string().uuid(), termId: z.string().uuid() });

/** GET /insurance-providers/:code/contracts?offered=true&country= */
export const listContractsQuerySchema = z.object({
  offered: z.enum(['true', 'false']).optional(),
});
