import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

registry.registerPath({
  method: 'post',
  path: '/api/internal/reminders/qualified',
  tags: ['Internal · Reminders'],
  summary: 'Envia lembretes para workers qualificados',
  description:
    'Envia lembretes de acompanhamento para workers que atingiram status QUALIFIED no Talentum. ' +
    'Disparado por Cloud Scheduler. Autenticado via X-API-Key interna.',
  security: [{ internalApiKey: [] }],
  responses: {
    200: { description: 'Lembretes enviados.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/reminders/5min',
  tags: ['Internal · Reminders'],
  summary: 'Lembrete de 5 minutos antes da entrevista',
  description:
    'Envia notificação de lembrete para workers com entrevista agendada nos próximos 5 minutos. ' +
    'Disparado por Cloud Scheduler a cada minuto. Autenticado via X-API-Key interna.',
  security: [{ internalApiKey: [] }],
  responses: {
    200: { description: 'Lembretes de 5min enviados.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
