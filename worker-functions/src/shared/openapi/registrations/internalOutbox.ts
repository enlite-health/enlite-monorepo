import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

registry.registerPath({
  method: 'post',
  path: '/api/internal/outbox/process',
  tags: ['Internal · Outbox'],
  summary: 'Processa mensagens do outbox de notificações',
  description:
    'Disparado por Cloud Tasks para processar entradas pendentes do outbox de notificações (WhatsApp, e-mail). ' +
    'Autenticado via X-API-Key interna.',
  security: [{ internalApiKey: [] }],
  responses: {
    200: { description: 'Outbox processado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/outbox/sweep',
  tags: ['Internal · Outbox'],
  summary: 'Varre outbox travado para reprocessamento',
  description:
    'Identifica entradas do outbox em estado stuck e as repõe para reprocessamento. ' +
    'Autenticado via X-API-Key interna.',
  security: [{ internalApiKey: [] }],
  responses: {
    200: { description: 'Sweep do outbox concluído.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
