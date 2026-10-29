/**
 * Validadores do quadro C (Servicio Contratado) — Fase 10, DX-10.7.
 *
 * `reasonCategory` é OPCIONAL/NULLABLE no zod de propósito: a ausência (ou `null`) não pode virar
 * 400 da borda — é 422 do caso de uso (`ServiceTeamReasonRequiredError`, critérios 8/9). O zod só
 * garante a FORMA (string, quando presente); a lista fechada por `kind` é conferida no domínio
 * (`serviceTeamReason.ts`).
 */
import { z } from 'zod';

export const serviceTeamParamsSchema = z.object({
  id: z.string().uuid(),
  sid: z.string().uuid(),
});

export const serviceTeamMarkBodySchema = z.object({
  workerId: z.string().uuid(),
  reasonCategory: z.string().nullish(),
});

export type ServiceTeamParams = z.infer<typeof serviceTeamParamsSchema>;
export type ServiceTeamMarkBody = z.infer<typeof serviceTeamMarkBodySchema>;
