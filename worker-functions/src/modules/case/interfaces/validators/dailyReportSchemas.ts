/**
 * Zod do informe da guarda (spec 092). A resposta de validação NUNCA ecoa valor: só o CAMINHO do campo (a narrativa é texto clínico).
 */
import { z } from 'zod';

export const reportIdParamSchema = z.string().uuid();

const answerSchema = z
  .object({
    objectiveId: z.string().uuid().optional(),
    activityId: z.string().uuid().optional(),
    scaleCode: z.string().min(1).max(16),
    optionCode: z.string().min(1).max(64).optional(),
    countValue: z.number().int().min(0).max(999).optional(),
    reasonCode: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((a) => (a.objectiveId === undefined) !== (a.activityId === undefined), { path: ['objectiveId'] })
  .refine((a) => (a.optionCode === undefined) !== (a.countValue === undefined), { path: ['optionCode'] })
  .refine((a) => a.reasonCode === undefined || a.optionCode !== undefined, { path: ['reasonCode'] });

export const submitDailyReportSchema = z
  .object({
    occurrenceId: z.string().uuid(),
    ptiVersionId: z.string().uuid().nullable(),
    narrative: z.string().refine((s) => s.trim().length >= 1 && s.length <= 8000, { message: 'invalid' }),
    narrativeSource: z.enum(['TYPED', 'DICTATED', 'MIXED']),
    deviceSubmittedAt: z.string().datetime({ offset: true }),
    appVersion: z.string().min(1).max(64),
    answers: z.array(answerSchema).max(600),
  })
  .strict()
  .refine((b) => new Set(b.answers.map((a) => a.objectiveId ?? a.activityId)).size === b.answers.length, { path: ['answers'] });

export type SubmitDailyReportBody = z.infer<typeof submitDailyReportSchema>;

export const templatesQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

/** Só os caminhos dos campos inválidos — nunca o valor recebido nem a mensagem do zod (pode citar o valor). */
export function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => i.path.join('.') || '(body)'))];
}
