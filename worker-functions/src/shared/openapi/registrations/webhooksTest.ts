import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

// Variantes /api/webhooks-test/* — mesmas rotas que /api/webhooks/* mas em ambiente de teste.
// Marcadas como deprecated para sinalizar que são endpoints de validação, não produção.

registry.registerPath({
  method: 'post',
  path: '/api/webhooks-test/talentum/prescreening',
  tags: ['Webhooks · Test'],
  summary: '[DEPRECATED] Talentum prescreening (teste)',
  description:
    'Variante de teste do webhook Talentum. Mesmo comportamento de /api/webhooks/talentum/prescreening ' +
    'mas com flag isTest=true no contexto de parceiro. Usar apenas para validação de integração.',
  deprecated: true,
  security: [{ partnerKey: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.record(z.unknown()).openapi({ description: 'Payload de teste do prescreening Talentum.' }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Evento de teste processado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Payload inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'X-Partner-Key inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/webhooks-test/twilio/status',
  tags: ['Webhooks · Test'],
  summary: '[DEPRECATED] Twilio status callback (teste)',
  description:
    'Variante de teste do webhook de status Twilio. ' +
    'Mesmo comportamento de /api/webhooks/twilio/status. Usar apenas para validação.',
  deprecated: true,
  security: [{ twilioSignature: [] }],
  request: {
    body: {
      content: {
        'application/x-www-form-urlencoded': {
          schema: z.record(z.string()).openapi({ description: 'Payload de status Twilio (teste).' }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Status de teste processado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Assinatura inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/webhooks-test/twilio/inbound',
  tags: ['Webhooks · Test'],
  summary: '[DEPRECATED] Twilio inbound WhatsApp (teste)',
  description:
    'Variante de teste do webhook inbound Twilio. ' +
    'Mesmo comportamento de /api/webhooks/twilio/inbound. Usar apenas para validação.',
  deprecated: true,
  security: [{ twilioSignature: [] }],
  request: {
    body: {
      content: {
        'application/x-www-form-urlencoded': {
          schema: z.record(z.string()).openapi({ description: 'Payload inbound Twilio (teste).' }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Inbound de teste processado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Assinatura inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/webhooks-test/clickup/patient',
  tags: ['Webhooks · Test'],
  summary: '[DEPRECATED] ClickUp patient webhook (teste)',
  description:
    'Variante de teste do webhook ClickUp de pacientes. ' +
    'Mesmo comportamento de /api/webhooks/clickup/patient. Usar apenas para validação.',
  deprecated: true,
  security: [{ clickupHmac: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.record(z.unknown()).openapi({ description: 'Payload ClickUp (teste).' }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Evento de teste processado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Schema inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'HMAC inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/webhooks-test/clickup/patient/_health',
  tags: ['Webhooks · Test'],
  summary: '[DEPRECATED] Liveness probe ClickUp (teste)',
  description:
    'Variante de teste do liveness probe do webhook ClickUp. ' +
    'Sem autenticação. Usar apenas para validação de infraestrutura.',
  deprecated: true,
  security: [],
  responses: {
    200: { description: 'Serviço vivo (ambiente de teste).', content: { 'application/json': { schema: OkMessage } } },
  },
});
