import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

const ClickUpWebhookBody = z.object({
  event: z.string().openapi({
    description: 'Tipo de evento ClickUp.',
    example: 'taskUpdated',
  }),
  webhook_id: z.string().openapi({ description: 'ID do webhook ClickUp.', example: 'wh_abc123' }),
  task_id: z.string().openapi({ description: 'ID da task ClickUp afetada.', example: '9hz12345' }),
  list_id: z.string().optional().openapi({ description: 'ID da lista (filtro antecipado — skipa se não for lista de pacientes).', example: '901304883903' }),
  history_items: z.array(z.unknown()).optional().openapi({ description: 'Histórico de alterações (opcional).' }),
}).openapi({ description: 'Payload do webhook ClickUp. Filtragem em 5 camadas antes de qualquer escrita no banco.' });

const ClickUpHealthResponse = z.object({
  status: z.literal('ok').openapi({ example: 'ok' }),
  service: z.literal('clickup-patient-webhook').openapi({ example: 'clickup-patient-webhook' }),
  patientListId: z.string().openapi({ example: '901304883903' }),
  uptimeSeconds: z.number().int().openapi({ example: 3600 }),
}).openapi({ description: 'Liveness probe do webhook ClickUp (sem auth, sem PII).' });

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/clickup/patient',
  tags: ['Webhooks · ClickUp'],
  summary: 'Recebe eventos de pacientes do ClickUp',
  description:
    'Sincroniza pacientes a partir de eventos ClickUp (taskCreated, taskUpdated, taskDeleted, etc.). ' +
    'Autenticado via X-Signature HMAC-SHA256. ' +
    'Filtragem em 5 camadas: HMAC → schema → list_id → fetch task → confirm list.',
  security: [{ clickupHmac: [] }],
  request: {
    body: {
      content: {
        'application/json': { schema: ClickUpWebhookBody },
      },
    },
  },
  responses: {
    200: { description: 'Evento processado (inclui skips por filtro).', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Schema inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'HMAC inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/webhooks/clickup/patient/_health',
  tags: ['Webhooks · ClickUp'],
  summary: 'Liveness probe do webhook ClickUp',
  description:
    'Probe de liveness sem autenticação. Não expõe PII nem contadores sensíveis. ' +
    'Usar em uptime checks do Cloud Monitoring.',
  security: [],
  responses: {
    200: {
      description: 'Serviço vivo.',
      content: { 'application/json': { schema: ClickUpHealthResponse } },
    },
  },
});
