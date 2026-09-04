/**
 * diagnosisSchemas — validação de entrada das rotas de diagnóstico (spec 016 F2).
 * `.strict()` em todos: campo estranho vira 400, nunca um no-op silencioso.
 */
import { z } from 'zod';

export const patientParamsSchema = z.object({ id: z.string().uuid() });
export const diagnosisParamsSchema = z.object({ id: z.string().uuid(), did: z.string().uuid() });

/**
 * POST /api/admin/patients/:id/diagnoses — "só a URI; o servidor resolve" (Contrato de
 * arquitetura). Nenhum campo de vocabulário (code/title/chapter/release) é aceito do cliente —
 * eles vêm SEMPRE da porta, nunca do payload.
 */
export const createDiagnosisSchema = z
  .object({
    conceptUri: z.string().trim().min(1, { message: 'conceptUri is required' }),
    isPrimary: z.boolean().optional(),
  })
  .strict();
export type CreateDiagnosisBody = z.infer<typeof createDiagnosisSchema>;

/**
 * PATCH /api/admin/patients/:id/diagnoses/:did — SEM DELETE. `isPrimary` só aceita `true`
 * (promover; "desmarcar principal" não existe — promove-se outro no lugar, molde
 * `updateContractedServiceSchema.active`). `active` só aceita `false` (baixa; reabrir não
 * existe). Exatamente UM dos dois por request — mistura os dois é 400, não uma ambiguidade
 * resolvida na fé sobre qual efeito aplicar primeiro.
 */
export const patchDiagnosisSchema = z
  .object({
    isPrimary: z.literal(true).optional(),
    active: z.literal(false).optional(),
  })
  .strict()
  .refine((d) => d.isPrimary !== undefined || d.active !== undefined, {
    message: 'isPrimary or active is required',
  })
  .refine((d) => !(d.isPrimary !== undefined && d.active !== undefined), {
    message: 'isPrimary and active are mutually exclusive',
  });
export type PatchDiagnosisBody = z.infer<typeof patchDiagnosisSchema>;
