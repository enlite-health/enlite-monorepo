import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

registry.registerPath({
  method: 'get',
  path: '/analytics/workers',
  tags: ['Analytics · Workers'],
  summary: 'Estatísticas analíticas de workers',
  description:
    'Retorna estatísticas aggregadas de workers: distribuição por status, ocupação, zona e origem. ' +
    'Usado por dashboards analíticos.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Estatísticas de workers.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/workers/missing-documents',
  tags: ['Analytics · Workers'],
  summary: 'Workers com documentos faltantes',
  description:
    'Retorna lista de workers que possuem documentos obrigatórios ausentes ou vencidos. ' +
    'Agrupado por tipo de documento faltante.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Workers com documentos faltantes.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/workers/{workerId}/vacancies',
  tags: ['Analytics · Workers'],
  summary: 'Vagas analíticas de um worker',
  description:
    'Retorna histórico de candidaturas e encuadres de um worker com métricas de desempenho. ' +
    'Inclui taxa de conversão e tempo médio por etapa.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      workerId: z.string().uuid().openapi({ description: 'UUID do worker.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
    }),
  },
  responses: {
    200: { description: 'Vagas e métricas do worker.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/vacancies',
  tags: ['Analytics · Vacancies'],
  summary: 'Estatísticas analíticas de vagas',
  description:
    'Retorna métricas aggregadas de vagas: distribuição por status, tempo de preenchimento e funil.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Estatísticas de vagas.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/vacancies/case/{caseNumber}',
  tags: ['Analytics · Vacancies'],
  summary: 'Métricas analíticas de vagas de um caso',
  description:
    'Retorna histórico e métricas de todas as vagas associadas a um caso clínico específico.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      caseNumber: z.string().openapi({ description: 'Número do caso clínico.', example: '766' }),
    }),
  },
  responses: {
    200: { description: 'Métricas de vagas do caso.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Caso não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/vacancies/{id}/incomplete-registrations',
  tags: ['Analytics · Vacancies'],
  summary: 'Registros incompletos de candidatos de uma vaga',
  description:
    'Retorna candidatos que iniciaram o processo para a vaga mas não completaram o cadastro. ' +
    'Usado para disparo de mensagens de reativação.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Candidatos com registro incompleto.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/vacancies/{id}',
  tags: ['Analytics · Vacancies'],
  summary: 'Métricas analíticas de uma vaga',
  description:
    'Retorna métricas detalhadas de uma vaga: candidatos por etapa, tempo por fase, ' +
    'taxa de conversão e histórico de publicações.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Métricas da vaga.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/dedup/candidates',
  tags: ['Analytics · Deduplication'],
  summary: 'Lista candidatos duplicados detectados',
  description:
    'Retorna pares de workers com alta probabilidade de serem a mesma pessoa. ' +
    'Critério: mesmo telefone, e-mail ou nome+data de nascimento similares.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Candidatos duplicados detectados.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/analytics/dedup/run',
  tags: ['Analytics · Deduplication'],
  summary: 'Executa deduplicação de workers (admin)',
  description:
    'Dispara o processo de merge de workers duplicados detectados. ' +
    'Operação exclusiva de admin — irreversível após merge.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Resultado da deduplicação.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem permissão de admin.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/dashboard/global',
  tags: ['Analytics · Dashboard'],
  summary: 'Dashboard analítico global',
  description:
    'Retorna visão consolidada de KPIs globais: workers ativos, vagas abertas, ' +
    'encuadres realizados e taxa de conversão no período.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'KPIs globais.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/dashboard/zones',
  tags: ['Analytics · Dashboard'],
  summary: 'Dashboard analítico por zonas',
  description:
    'Retorna KPIs segmentados por zona geográfica: demanda vs oferta de workers por região.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'KPIs por zonas.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/dashboard/reemplazos',
  tags: ['Analytics · Dashboard'],
  summary: 'Dashboard de reemplazos (substituições)',
  description:
    'Retorna métricas de substituições: casos que precisam de reemplazo, ' +
    'tempo médio para reemplazar e taxa de sucesso.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Métricas de reemplazos.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/analytics/dashboard/cases/{caseNumber}',
  tags: ['Analytics · Dashboard'],
  summary: 'Dashboard analítico de um caso',
  description:
    'Retorna timeline e métricas completas de um caso clínico: histórico de vagas, ' +
    'workers testados e tempo de processo.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      caseNumber: z.string().openapi({ description: 'Número do caso clínico.', example: '766' }),
    }),
  },
  responses: {
    200: { description: 'Dashboard do caso.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Caso não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
