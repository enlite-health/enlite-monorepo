import { z } from 'zod';

export const PAYER_KINDS = ['OBRA_SOCIAL', 'PREPAGA', 'PRIVATE'] as const;

/** Texto não vazio depois do trim: `''` é erro (nunca "limpar" — limpar é `null`). */
const nonBlank = (max: number) => z.string().trim().min(1).max(max);

/**
 * POST /catalogs/insurance-providers — `{ name, code?, aliases? }` (spec 058 §3.2 §W). `code` ausente é derivado do nome por
 * `deriveProviderCode`; quando vem, tem a mesma forma do CHECK `insurance_providers_code_upper` (311).
 */
export const createInsuranceProviderSchema = z
  .object({
    name: nonBlank(200),
    code: z.string().trim().min(2).max(64).regex(/^[A-Z][A-Z0-9_]*$/, 'code: MAIÚSCULAS, dígitos e _ (ex.: SWISS_MEDICAL)').optional(),
    sortOrder: z.number().int().positive().optional(),
    aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict();

/**
 * PATCH /insurance-providers/:code — ausente = não toca; `null` = limpa (só os anuláveis); `''` = erro; `code` = erro (imutável,
 * tratado no controller como 422 `CODE_IMMUTABLE` antes deste parse). Erro de validação do PATCH é 422 (spec §3.2 §W).
 */
export const patchInsuranceProviderSchema = z
  .object({
    name: nonBlank(200).optional(),
    legalName: nonBlank(200).nullable().optional(),
    taxId: nonBlank(40).nullable().optional(),
    address: nonBlank(500).nullable().optional(),
    managementChatId: nonBlank(200).nullable().optional(),
    payerKind: z.enum(PAYER_KINDS).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const providerCodeParamSchema = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64) });

/** GET /insurance-providers?search=&includeInactive= */
export const listInsuranceProvidersQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

/** GET /insurance-providers/for-service?country=&selected= */
export const forServiceQuerySchema = z.object({
  country: z.enum(['AR', 'BR']),
  selected: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64).optional(),
});
