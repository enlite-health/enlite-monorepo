import { z } from 'zod';
import { DECISIONS, RESOLUTION_CODES, REVIEW_KINDS } from '../../application/ports/PresenceReviewPorts';

/** A borda da fila de revisão de presença (emenda 077 §6): só FORMA. Código de resolução da lista fechada de 5, obrigatório; o resto é do attendance. */
export const presenceReviewQuerySchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    kind: z.enum(REVIEW_KINDS).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export const presenceDecisionParamsSchema = z.object({ eventId: z.string().uuid() });

export const presenceDecisionBodySchema = z
  .object({
    decision: z.enum(DECISIONS),
    resolution_code: z.enum(RESOLUTION_CODES),
  })
  .strict(); // `decided_by_uid` NUNCA vem do corpo: é o uid do ator autenticado
