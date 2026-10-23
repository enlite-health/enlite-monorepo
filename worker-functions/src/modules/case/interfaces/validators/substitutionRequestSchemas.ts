import { z } from 'zod';
import { dayCountInclusive } from '../../domain/itineraryEvents';
import { isRealCalendarDate, itineraryServiceParamsSchema } from './itineraryWriteSchemas';

/**
 * substitutionRequestSchemas — a borda do pedido de substituição (spec 069). Zod valida só FORMA (uuid, data de calendário real,
 * período coerente); regra de negócio (motivo do catálogo, data não passada, turnos da pessoa, Selecionado) é do caso de uso.
 *
 * O substituto de CADA turno é OBRIGATÓRIO e nullable (P16, memória `vazio-ambiguo-nao-e-informacao-de-ausencia`): `null` =
 * "Nadie todavía", chave ausente = 400 — nunca um padrão silencioso. `.optional()` aqui seria o defeito.
 */

/** Teto de dias de UM pedido de "Varios días" (uma transação, N ausências com gatilho cada). */
export const SUBSTITUTION_MAX_DAYS = 92;

export const substitutionServiceParamsSchema = itineraryServiceParamsSchema;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDate, { message: 'must be a real calendar date' });

export const substitutionListQuerySchema = z.object({ when: z.enum(['upcoming', 'past']).default('upcoming') });
export type SubstitutionListQuery = z.infer<typeof substitutionListQuerySchema>;

const periodFields = {
  type: z.enum(['ONE_DAY', 'DAYS']),
  outgoingWorkerId: z.string().uuid(),
  from: isoDate,
  to: isoDate.optional(),
};

type PeriodShape = { type: 'ONE_DAY' | 'DAYS'; from: string; to?: string };

/** `ONE_DAY`: `to` ausente ou igual a `from`. `DAYS`: `to` obrigatório, `from <= to` e no máximo `SUBSTITUTION_MAX_DAYS` dias. */
function validatePeriod(v: PeriodShape, ctx: z.RefinementCtx): void {
  if (v.type === 'ONE_DAY') {
    if (v.to !== undefined && v.to !== v.from) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'ONE_DAY has a single date' });
    return;
  }
  if (v.to === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'DAYS requires `to`' });
    return;
  }
  if (v.to < v.from) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '`to` is before `from`' });
  else if (dayCountInclusive(v.from, v.to) > SUBSTITUTION_MAX_DAYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `period exceeds ${SUBSTITUTION_MAX_DAYS} days` });
  }
}

/** `to` sai sempre preenchido (ONE_DAY → `from`). */
const withTo = <T extends PeriodShape>(v: T): Omit<T, 'to'> & { to: string } => ({ ...v, to: v.to ?? v.from });

export const substitutionPreviewBodySchema = z
  .object({ ...periodFields, candidateWorkerIds: z.array(z.string().uuid()).max(30) })
  .strict()
  .superRefine(validatePeriod)
  .transform(withTo);
export type SubstitutionPreviewBody = z.infer<typeof substitutionPreviewBodySchema>;

export const substitutionShiftBodySchema = z
  .object({
    date: isoDate,
    slotId: z.string().uuid(),
    // OBRIGATÓRIO e nullable: `null` = "Nadie todavía"; a chave ausente é 400.
    substituteWorkerId: z.union([z.string().uuid(), z.null()]),
  })
  .strict();

export const substitutionCreateBodySchema = z
  .object({
    ...periodFields,
    // Motivo: ausente/vazio NÃO vira 400 da borda — é 422 `REASON_REQUIRED` do caso de uso (mesmo molde de `itineraryAbsenceBodySchema`).
    reasonCategory: z.string().nullish(),
    shifts: z.array(substitutionShiftBodySchema).max(400),
  })
  .strict()
  .superRefine(validatePeriod)
  .transform(withTo);
export type SubstitutionCreateBody = z.infer<typeof substitutionCreateBodySchema>;
