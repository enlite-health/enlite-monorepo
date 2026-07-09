import { z } from 'zod';

/**
 * Validação de trust boundary do webhook Periskope (PeriskopeWebhookController).
 * A assinatura HMAC garante autenticidade da origem, mas não a forma do
 * payload — o parse Zod garante isso antes de qualquer lógica de negócio.
 */

/** Envelope comum a todo evento do Periskope. `data` é validado por evento
 * específico depois (PeriskopeMessageCreatedDataSchema / PeriskopeAckUpdatedDataSchema). */
export const PeriskopeWebhookEnvelopeSchema = z.object({
  event: z.string(),
  data: z.record(z.unknown()).optional().default({}),
  org_id: z.string().optional(),
  timestamp: z.string().optional(),
});

/** Campos do Message Object consumidos no evento message.created. */
export const PeriskopeMessageCreatedDataSchema = z.object({
  message_id: z.string().optional(),
  chat_id: z.string().optional(),
  body: z.string().optional(),
  message_type: z.string().optional(),
  from_me: z.boolean().optional(),
});

/** Campos consumidos no evento message.ack.updated (delivery tracking). */
export const PeriskopeAckUpdatedDataSchema = z.object({
  message_id: z.string().optional(),
  chat_id: z.string().optional(),
  ack: z.number().optional(),
});

export type PeriskopeWebhookEnvelope = z.infer<typeof PeriskopeWebhookEnvelopeSchema>;
export type PeriskopeMessageCreatedData = z.infer<typeof PeriskopeMessageCreatedDataSchema>;
export type PeriskopeAckUpdatedData = z.infer<typeof PeriskopeAckUpdatedDataSchema>;
