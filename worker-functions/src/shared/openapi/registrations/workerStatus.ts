import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const UpdateStatusBody = z.object({
  status: z.enum(['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED']).openapi({
    description: 'Novo status do worker.',
    example: 'REGISTERED',
  }),
});

const UpdateOccupationBody = z.object({
  occupation: z.enum(['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST']).openapi({
    description: 'Tipo de ocupação do worker.',
    example: 'AT',
  }),
});

const UpdateDocExpiryBody = z.object({
  criminalRecordExpiry: z.string().optional().openapi({ description: 'Data de vencimento dos antecedentes penais (ISO).', example: '2026-12-31' }),
  insuranceExpiry: z.string().optional().openapi({ description: 'Data de vencimento do seguro.', example: '2026-06-30' }),
  professionalRegExpiry: z.string().optional().openapi({ description: 'Data de vencimento do registro profissional.', example: '2027-01-01' }),
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/status-dashboard',
  tags: ['Worker · Status'],
  summary: 'Dashboard de contagens por status',
  description:
    'Retorna contagens agregadas de workers por status (REGISTERED, INCOMPLETE_REGISTER, DISABLED). ' +
    'Usado pelo painel administrativo.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Dashboard de status dos workers.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/by-status/{status}',
  tags: ['Worker · Status'],
  summary: 'Lista workers por status',
  description:
    'Retorna workers filtrados por status com paginação. ' +
    'Status aceitos: REGISTERED, INCOMPLETE_REGISTER, DISABLED.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      status: z.string().openapi({ description: 'Status do worker.', example: 'REGISTERED' }),
    }),
    query: z.object({
      limit: z.coerce.number().optional().openapi({ description: 'Máximo de itens (default 50, teto 200).', example: 50 }),
      offset: z.coerce.number().optional().openapi({ description: 'Itens a pular.', example: 0 }),
      occupation: z.string().optional().openapi({ description: 'Filtro por ocupação.', example: 'AT' }),
    }),
  },
  responses: {
    200: { description: 'Lista de workers pelo status.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Status inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/workers/{id}/status',
  tags: ['Worker · Status'],
  summary: 'Atualiza status do worker',
  description:
    'Altera o status do worker. Para REGISTERED, recalcula com base nos campos obrigatórios. ' +
    'Requer Firebase token de staff/admin.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: UpdateStatusBody } } },
  },
  responses: {
    200: { description: 'Status atualizado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Status inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/workers/{id}/occupation',
  tags: ['Worker · Status'],
  summary: 'Atualiza ocupação do worker',
  description:
    'Define a ocupação principal do worker (AT, CAREGIVER, NURSE, etc.). ' +
    'Afeta a elegibilidade para vagas.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: UpdateOccupationBody } } },
  },
  responses: {
    200: { description: 'Ocupação atualizada.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Ocupação inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/docs-expiring',
  tags: ['Worker · Status'],
  summary: 'Lista workers com documentos vencendo',
  description:
    'Retorna workers cujos documentos (antecedentes penais, seguro ou registro profissional) ' +
    'vencerão nos próximos 30 dias.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Lista de workers com docs a vencer.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/workers/{id}/doc-expiry',
  tags: ['Worker · Status'],
  summary: 'Atualiza datas de vencimento de documentos',
  description:
    'Persiste datas de validade para antecedentes penais, seguro e registro profissional. ' +
    'Campos são opcionais — atualiza apenas o que for informado.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: UpdateDocExpiryBody } } },
  },
  responses: {
    200: { description: 'Datas de vencimento atualizadas.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/{id}/encuadres',
  tags: ['Worker · Status'],
  summary: 'Lista encuadres do worker',
  description:
    'Retorna histórico de encuadres (entrevistas de matching) do worker especificado. ' +
    'Inclui resultado, datas e dados de vagas.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Histórico de encuadres.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/{id}/cases',
  tags: ['Worker · Cases'],
  summary: 'Lista casos vinculados ao worker',
  description:
    'Retorna os casos clínicos (vagas) com os quais o worker teve algum encuadre, ' +
    'agrupados por vaga e com status derivado do último resultado.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Lista de casos do worker.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/cases/{caseNumber}/encuadres',
  tags: ['Worker · Cases'],
  summary: 'Lista encuadres de um caso clínico',
  description:
    'Retorna todos os encuadres de uma vaga pelo número de caso. ' +
    'Inclui resumo por resultado (PENDIENTE, SELECCIONADO, RECHAZADO, etc.).',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      caseNumber: z.string().openapi({ description: 'Número do caso clínico.', example: '766' }),
    }),
  },
  responses: {
    200: { description: 'Encuadres do caso.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'caseNumber inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Caso não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/cases/{caseNumber}/workers',
  tags: ['Worker · Cases'],
  summary: 'Lista workers de um caso clínico',
  description:
    'Retorna os workers que participaram de encuadres para o caso clínico, ' +
    'agrupados por worker com status derivado do último resultado.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      caseNumber: z.string().openapi({ description: 'Número do caso clínico.', example: '766' }),
    }),
  },
  responses: {
    200: { description: 'Workers do caso.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'caseNumber inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Caso não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
