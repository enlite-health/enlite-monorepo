import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

registry.registerPath({
  method: 'post',
  path: '/api/internal/workers/webhook',
  tags: ['Internal · Webhooks'],
  summary: 'Webhook interno de atualização de workers',
  description:
    'Endpoint legado para receber notificações internas de mudanças em workers. ' +
    'Autenticado via X-API-Key interna. Não deve ser chamado pelo frontend.',
  security: [{ internalApiKey: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.record(z.unknown()).openapi({ description: 'Payload do evento de worker.' }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Webhook processado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
