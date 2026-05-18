import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/{id}/funnel',
  tags: ['Admin · Funnel'],
  summary: 'Retorna funil de encuadres (Kanban)',
  description:
    'Retorna os encuadres da vaga organizados em colunas de funil para visualização Kanban. ' +
    'Colunas: INITIATED, PENDIENTE, SELECCIONADO, RECHAZADO, AT_NO_ACEPTA.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Funil de encuadres por coluna.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/{id}/funnel-table',
  tags: ['Admin · Funnel'],
  summary: 'Retorna funil de encuadres em formato tabela',
  description:
    'Retorna os encuadres da vaga em formato tabular com dados detalhados de cada candidato. ' +
    'Alternativa ao Kanban para visualização em lista.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Encuadres em formato tabular.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
