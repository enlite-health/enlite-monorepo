import { z } from 'zod';
import { CONTEST_NOTE_MAX_LENGTH, CONTEST_REASONS, VALIDATE_BATCH_MAX_SHIFTS } from '../../domain/AnaCareShift';

export const monthParamsSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
export const monthPatientParamsSchema = monthParamsSchema.extend({ patientId: z.string().min(1) });
export const shiftParamsSchema = z.object({ shiftId: z.string().min(1) });

// D4 (revisão de conformidade, 15/09): o filtro por paciente/prestador SHALL rodar só no
// CLIENTE (`selectors.ts` `filterPatients`) — nunca como query string pro backend (nome de
// paciente em URL/log é PII, regra dura do brief e do CLAUDE.md). `.strict()`: qualquer query
// (inclusive `patientSearch`/`providerId` de um cliente antigo) é 400 — silenciar o parâmetro em
// vez de rejeitar deixaria alguém achar que o filtro "funciona" no servidor quando nunca rodou lá.
export const monthQuerySchema = z.object({}).strict();

export const validateBatchBodySchema = z.object({
  shiftIds: z.array(z.string().min(1)).min(1).max(VALIDATE_BATCH_MAX_SHIFTS),
});

export const contestShiftBodySchema = z.object({
  reason: z.enum(CONTEST_REASONS),
  note: z.string().trim().max(CONTEST_NOTE_MAX_LENGTH).optional(),
});

/** Corpo opcional do disparo de sync (F4 continuação) — `month`/`cursor`/`budgetMs` retomam uma rodada parcial. */
export const syncTriggerBodySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  cursor: z.number().int().min(0).nullable().optional(),
  budgetMs: z.number().int().positive().optional(),
});
