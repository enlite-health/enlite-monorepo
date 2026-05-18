import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

registry.registerPath({
  method: 'get',
  path: '/api/admin/workers/stats',
  tags: ['Admin · Workers'],
  summary: 'Estatísticas gerais de workers',
  description:
    'Retorna contagens por status, plataforma de origem e documentação. ' +
    'Usado no dashboard administrativo.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Estatísticas dos workers.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/workers/by-phone',
  tags: ['Admin · Workers'],
  summary: 'Busca worker por telefone',
  description:
    'Retorna detalhes completos de um worker pelo número de telefone (aceita formatos variados). ' +
    'Retorna os mesmos dados de GET /api/admin/workers/:id.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      phone: z.string().min(1).openapi({ description: 'Número de telefone (aceita E.164 ou local).', example: '+5491112345678' }),
    }),
  },
  responses: {
    200: { description: 'Detalhes do worker.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Telefone inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/workers/case-options',
  tags: ['Admin · Workers'],
  summary: 'Lista opções de caso para seleção',
  description:
    'Retorna lista simplificada de workers vinculados a casos para uso em dropdowns. ' +
    'Inclui apenas ID, nome e case_number.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Opções de caso.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/workers/sync-talentum',
  tags: ['Admin · Workers'],
  summary: 'Sincroniza workers com Talentum',
  description:
    'Dispara importação manual de candidatos do Talentum. ' +
    'Operação assíncrona — cria ou atualiza workers com base nos dados do Talentum.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Sincronização iniciada ou concluída.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: { description: 'Falha na comunicação com Talentum.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/workers/export',
  tags: ['Admin · Workers'],
  summary: 'Exporta workers para CSV ou XLSX',
  description:
    'Exporta workers com filtros opcionais para CSV (streaming) ou XLSX (buffered). ' +
    'Requer permissão de admin. Timeout de 5 minutos para exportações grandes.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      format: z.enum(['csv', 'xlsx']).openapi({ description: 'Formato de saída.', example: 'csv' }),
      columns: z.string().min(1).openapi({ description: 'Colunas separadas por vírgula.', example: 'name,email,status' }),
      status: z.string().optional().openapi({ description: 'Filtro por status.', example: 'REGISTERED' }),
      platform: z.string().optional().openapi({ description: 'Filtro por plataforma de origem.', example: 'talentum' }),
      docs_complete: z.string().optional().openapi({ description: 'Filtro por completude de docs.', example: 'complete' }),
      docs_validated: z.enum(['all_validated', 'pending_validation']).optional().openapi({ description: 'Filtro por validação de docs.' }),
      case_id: z.string().optional().openapi({ description: 'Filtro por vaga (UUID).', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
    }),
  },
  responses: {
    200: { description: 'Arquivo de exportação (CSV ou XLSX).', content: { 'text/csv': { schema: z.string().openapi({ description: 'CSV stream.' }) } } },
    400: { description: 'Parâmetros inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem permissão de admin.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/workers/{id}',
  tags: ['Admin · Workers'],
  summary: 'Detalhes completos de um worker',
  description:
    'Retorna todos os dados descriptografados de um worker (PII incluído). ' +
    'Inclui documentos, encuadres e histórico de status.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Dados completos do worker.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/workers',
  tags: ['Admin · Workers'],
  summary: 'Lista workers com filtros e paginação',
  description:
    'Retorna workers com filtros opcionais de plataforma, documentação, status e busca textual. ' +
    'Busca por nome usa blind index trigram para proteger PII.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      platform: z.string().optional().openapi({ description: 'Filtro de plataforma (talentum, enlite_app).', example: 'talentum' }),
      docs_complete: z.string().optional().openapi({ description: 'Filtro de docs (complete, incomplete).', example: 'complete' }),
      docs_validated: z.enum(['all_validated', 'pending_validation']).optional().openapi({ description: 'Filtro de validação de docs.' }),
      search: z.string().optional().openapi({ description: 'Busca por nome, e-mail ou telefone.', example: 'João Silva' }),
      case_id: z.string().optional().openapi({ description: 'Filtro por vaga (UUID).', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
      limit: z.string().optional().openapi({ description: 'Máximo de itens (default 20).', example: '20' }),
      offset: z.string().optional().openapi({ description: 'Itens a pular (default 0).', example: '0' }),
    }),
  },
  responses: {
    200: { description: 'Lista paginada de workers.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Query params inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
