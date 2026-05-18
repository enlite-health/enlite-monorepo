import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

const TwilioStatusPayload = z.object({
  MessageSid: z.string().openapi({ description: 'SID da mensagem Twilio.', example: 'SM1234567890abcdef' }),
  MessageStatus: z.string().openapi({ description: 'Novo status da mensagem.', example: 'delivered' }),
  To: z.string().openapi({ description: 'Número de destino.', example: 'whatsapp:+5491112345678' }),
  From: z.string().openapi({ description: 'Número de origem.', example: 'whatsapp:+14155238886' }),
}).openapi({ description: 'Callback de status de mensagem Twilio (form-encoded).' });

const TwilioInboundPayload = z.object({
  From: z.string().openapi({ description: 'Número do remetente.', example: 'whatsapp:+5491112345678' }),
  Body: z.string().openapi({ description: 'Texto da mensagem recebida.', example: 'Sim, tenho interesse!' }),
  MessageSid: z.string().openapi({ description: 'SID da mensagem.', example: 'SM1234567890abcdef' }),
}).openapi({ description: 'Payload de mensagem WhatsApp inbound via Twilio.' });

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/twilio/status',
  tags: ['Webhooks · Twilio'],
  summary: 'Callback de status de mensagem Twilio',
  description:
    'Recebe callbacks de atualização de status de mensagens WhatsApp (sent, delivered, failed, etc.). ' +
    'Autenticado via X-Twilio-Signature (HMAC-SHA1). ' +
    'Corpo em application/x-www-form-urlencoded.',
  security: [{ twilioSignature: [] }],
  request: {
    body: {
      content: {
        'application/x-www-form-urlencoded': { schema: TwilioStatusPayload },
      },
    },
  },
  responses: {
    200: { description: 'Status processado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Assinatura Twilio inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/twilio/inbound',
  tags: ['Webhooks · Twilio'],
  summary: 'Recebe mensagem WhatsApp inbound do worker',
  description:
    'Processa respostas enviadas pelo worker via WhatsApp para a linha Twilio. ' +
    'Implementa Step 7 do fluxo de matching (resposta a convite de entrevista). ' +
    'Autenticado via X-Twilio-Signature.',
  security: [{ twilioSignature: [] }],
  request: {
    body: {
      content: {
        'application/x-www-form-urlencoded': { schema: TwilioInboundPayload },
      },
    },
  },
  responses: {
    200: { description: 'Mensagem inbound processada.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Assinatura Twilio inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
