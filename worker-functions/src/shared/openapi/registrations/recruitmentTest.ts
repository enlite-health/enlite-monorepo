import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

// Rotas /api/test/recruitment/* — versões públicas (sem auth) dos endpoints de recruitment admin.
// Marcadas como deprecated — servem apenas para testes sem autenticação.

registry.registerPath({
  method: 'get',
  path: '/api/test/recruitment/clickup-cases',
  tags: ['Recruitment · Test'],
  summary: '[DEPRECATED] Casos ClickUp sem auth (teste)',
  description:
    'Variante pública sem autenticação de /api/admin/recruitment/clickup-cases. ' +
    'Usar apenas para testes de integração. Deprecated.',
  deprecated: true,
  security: [],
  responses: {
    200: { description: 'Casos ClickUp.', content: { 'application/json': { schema: OkMessage } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/test/recruitment/talentum-workers',
  tags: ['Recruitment · Test'],
  summary: '[DEPRECATED] Workers Talentum sem auth (teste)',
  description:
    'Variante pública sem autenticação de /api/admin/recruitment/talentum-workers. Deprecated.',
  deprecated: true,
  security: [],
  responses: {
    200: { description: 'Workers Talentum.', content: { 'application/json': { schema: OkMessage } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/test/recruitment/progreso',
  tags: ['Recruitment · Test'],
  summary: '[DEPRECATED] Progresso de recrutamento sem auth (teste)',
  description:
    'Variante pública sem autenticação de /api/admin/recruitment/progreso. Deprecated.',
  deprecated: true,
  security: [],
  responses: {
    200: { description: 'Progresso do pipeline.', content: { 'application/json': { schema: OkMessage } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/test/recruitment/publications',
  tags: ['Recruitment · Test'],
  summary: '[DEPRECATED] Publicações de vagas sem auth (teste)',
  description:
    'Variante pública sem autenticação de /api/admin/recruitment/publications. Deprecated.',
  deprecated: true,
  security: [],
  responses: {
    200: { description: 'Publicações.', content: { 'application/json': { schema: OkMessage } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/test/recruitment/encuadres',
  tags: ['Recruitment · Test'],
  summary: '[DEPRECATED] Encuadres de pipeline sem auth (teste)',
  description:
    'Variante pública sem autenticação de /api/admin/recruitment/encuadres. Deprecated.',
  deprecated: true,
  security: [],
  responses: {
    200: { description: 'Encuadres do pipeline.', content: { 'application/json': { schema: OkMessage } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/test/recruitment/global-metrics',
  tags: ['Recruitment · Test'],
  summary: '[DEPRECATED] Métricas globais sem auth (teste)',
  description:
    'Variante pública sem autenticação de /api/admin/recruitment/global-metrics. Deprecated.',
  deprecated: true,
  security: [],
  responses: {
    200: { description: 'Métricas globais.', content: { 'application/json': { schema: OkMessage } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
