import { z } from 'zod';
import { CONTEST_NOTE_MAX_LENGTH, CONTEST_REASONS, VALIDATE_BATCH_MAX_SHIFTS } from '../../domain/AnaCareShift';

export const monthParamsSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
export const monthPatientParamsSchema = monthParamsSchema.extend({ patientId: z.string().min(1) });
export const shiftParamsSchema = z.object({ shiftId: z.string().min(1) });

export const monthQuerySchema = z.object({
  patientSearch: z.string().trim().min(1).optional(),
  providerId: z.string().trim().min(1).optional(),
});

export const validateBatchBodySchema = z.object({
  shiftIds: z.array(z.string().min(1)).min(1).max(VALIDATE_BATCH_MAX_SHIFTS),
});

export const contestShiftBodySchema = z.object({
  reason: z.enum(CONTEST_REASONS),
  note: z.string().trim().max(CONTEST_NOTE_MAX_LENGTH).optional(),
});
