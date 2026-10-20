import { z } from 'zod';
import { isoDate } from './insuranceContractSchemas';

const rangeOrdered = (v: { validFrom: string; validTo?: string | null }): boolean =>
  v.validTo === undefined || v.validTo === null || v.validTo >= v.validFrom;
const rangeMessage = { message: 'validTo before validFrom', path: ['validTo'] };

/** POST …/contract-link — vínculo NOVO. `validTo` inclusivo; ausente/null = sem fim. */
export const createContractLinkSchema = z
  .object({
    contractId: z.string().uuid(),
    validFrom: isoDate,
    validTo: isoDate.nullable().optional(),
  })
  .strict()
  .refine(rangeOrdered, rangeMessage);

/** POST …/contract-link/end — último dia vigente (inclusivo). */
export const endContractLinkSchema = z.object({ validTo: isoDate }).strict();

/** POST …/contract-link/supersede — `SWITCHED` (troca de contrato do MESMO pagador) ou `CORRECTION` (correção de cadastro). */
export const supersedeContractLinkSchema = z
  .object({
    reason: z.enum(['CORRECTION', 'SWITCHED']),
    contractId: z.string().uuid(),
    validFrom: isoDate,
    validTo: isoDate.nullable().optional(),
  })
  .strict()
  .refine(rangeOrdered, rangeMessage);

export const linkParamsSchema = z.object({ id: z.string().uuid(), sid: z.string().uuid() });
