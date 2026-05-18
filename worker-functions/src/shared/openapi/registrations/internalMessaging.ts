import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

registry.registerPath({
  method: 'post',
  path: '/api/internal/bulk-dispatch/process',
  tags: ['Internal · Messaging'],
  summary: 'Processa fila de bulk dispatch de mensagens',
  description:
    'Processa a fila de envios em massa agendados pelo endpoint de bulk-dispatch-incomplete. ' +
    'Disparado por Cloud Tasks. Autenticado via X-API-Key interna.',
  security: [{ internalApiKey: [] }],
  responses: {
    200: { description: 'Bulk dispatch processado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
