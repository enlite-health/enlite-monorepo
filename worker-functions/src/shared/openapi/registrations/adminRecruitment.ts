import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

registry.registerPath({
  method: 'get',
  path: '/api/admin/recruitment/clickup-cases',
  tags: ['Admin · Recruitment'],
  summary: 'Retorna casos ClickUp do pipeline',
  description:
    'Lista casos (pacientes) sincronizados do ClickUp com status do pipeline de recrutamento. ' +
    'Usado pelo dashboard de recruitment.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Casos ClickUp.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/recruitment/talentum-workers',
  tags: ['Admin · Recruitment'],
  summary: 'Retorna workers do Talentum no pipeline',
  description:
    'Lista workers originados do Talentum com status de prescreening e funil. ' +
    'Complementar aos dados locais da plataforma.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Workers do Talentum.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/recruitment/progreso',
  tags: ['Admin · Recruitment'],
  summary: 'Progresso do pipeline de recrutamento',
  description:
    'Retorna métricas de progresso do pipeline de recrutamento: ' +
    'candidatos em cada etapa e taxas de conversão.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Progresso do pipeline.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/recruitment/publications',
  tags: ['Admin · Recruitment'],
  summary: 'Lista publicações de vagas',
  description:
    'Retorna histórico de publicações de vagas por canal e recruiter. ' +
    'Inclui data de publicação e status.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Publicações de vagas.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/recruitment/encuadres',
  tags: ['Admin · Recruitment'],
  summary: 'Lista encuadres do pipeline',
  description:
    'Retorna todos os encuadres agregados para visão de pipeline de recrutamento. ' +
    'Diferente do funil por vaga — aqui é visão global.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Encuadres do pipeline.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/recruitment/global-metrics',
  tags: ['Admin · Recruitment'],
  summary: 'Métricas globais de recrutamento',
  description:
    'Retorna KPIs globais: total de candidatos, taxa de aprovação, tempo médio de processo, ' +
    'vagas preenchidas no período.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Métricas globais.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/recruitment/case/{caseNumber}',
  tags: ['Admin · Recruitment'],
  summary: 'Detalhe de recrutamento de um caso',
  description:
    'Retorna dados completos de recrutamento para um caso clínico específico: ' +
    'vagas, encuadres, workers e publicações.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      caseNumber: z.string().openapi({ description: 'Número do caso clínico.', example: '766' }),
    }),
  },
  responses: {
    200: { description: 'Dados de recrutamento do caso.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Caso não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/recruitment/zones',
  tags: ['Admin · Recruitment'],
  summary: 'Distribuição de vagas por zona geográfica',
  description:
    'Retorna contagem de vagas abertas e workers disponíveis por zona de atendimento. ' +
    'Usado para identificar desbalanceamento geográfico.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Distribuição por zonas.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/recruitment/calculate-reemplazos',
  tags: ['Admin · Recruitment'],
  summary: 'Calcula workers para reemplazos (substituições)',
  description:
    'Executa cálculo de reemplazos: identifica workers elegíveis para substituições em casos ativos. ' +
    'Considera disponibilidade, histórico e zona geográfica.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Resultado do cálculo de reemplazos.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
