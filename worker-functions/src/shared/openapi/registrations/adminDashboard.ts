import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

registry.registerPath({
  method: 'get',
  path: '/api/admin/dashboard/coordinator-capacity',
  tags: ['Admin · Dashboard'],
  summary: 'Capacidade de atendimento por coordenador',
  description:
    'Retorna métricas de capacidade de atendimento para cada coordenador: ' +
    'vagas abertas, workers em matching e casos ativos sob sua responsabilidade.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Capacidade por coordenador.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/dashboard/alerts',
  tags: ['Admin · Dashboard'],
  summary: 'Alertas operacionais do dashboard',
  description:
    'Retorna alertas críticos: vagas abertas há mais de X dias, workers com docs vencendo, ' +
    'casos sem coordinator atribuído e outras métricas de atenção.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Lista de alertas operacionais.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/dashboard/conversion-by-channel',
  tags: ['Admin · Dashboard'],
  summary: 'Conversão de candidatos por canal',
  description:
    'Retorna métricas de conversão (taxa de avanço no funil) segmentadas por canal de aquisição ' +
    '(facebook, instagram, whatsapp, linkedin, site).',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Conversão por canal.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
