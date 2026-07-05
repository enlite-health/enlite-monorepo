import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

registry.registerPath({
  method: 'post',
  path: '/api/internal/events/process',
  tags: ['Internal · Events'],
  summary: 'Processa domain events pendentes',
  description:
    'Disparado por Cloud Tasks para processar domain events da fila. ' +
    'Autenticado via X-API-Key interna. Não deve ser chamado diretamente pelo frontend.',
  security: [{ internalApiKey: [] }],
  responses: {
    200: { description: 'Events processados.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/events/sweep',
  tags: ['Internal · Events'],
  summary: 'Varre events travados para reprocessamento',
  description:
    'Identifica domain events em estado stuck (processando há mais de X minutos) e os repõe na fila. ' +
    'Autenticado via X-API-Key interna.',
  security: [{ internalApiKey: [] }],
  responses: {
    200: { description: 'Sweep concluído.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/internal/events/health',
  tags: ['Internal · Events'],
  summary: 'Backlog/idade do outbox domain_events por tipo de evento',
  description:
    'Diagnóstico read-only: agrega domain_events por tipo de evento e reporta backlog pendente, ' +
    'backlog "recente" (dentro de recentWindowHours) e a idade do pending recente mais antigo. ' +
    'Loga WARN estruturado para cada grupo stuck (idade > stuckThresholdMinutes). ' +
    'Autenticado via X-API-Key interna.',
  security: [{ internalApiKey: [] }],
  responses: {
    200: { description: 'Summary calculado com sucesso.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'X-API-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
