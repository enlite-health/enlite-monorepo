import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const AdminPatientsListQuery = z.object({
  status: z.string().optional().openapi({ description: 'Filtro por status do paciente.', example: 'ACTIVE' }),
  search: z.string().optional().openapi({ description: 'Busca textual por nome ou caso.', example: 'João' }),
  needs_attention: z.string().optional().openapi({ description: 'Filtro de atenção requerida (true/false).', example: 'true' }),
  limit: z.coerce.number().optional().openapi({ description: 'Máximo de itens (default 20).', example: 20 }),
  offset: z.coerce.number().optional().openapi({ description: 'Itens a pular (default 0).', example: 0 }),
});

const CreatePatientAddressBody = z.object({
  address_formatted: z.string().min(1).openapi({
    description: 'Endereço formatado para exibição e geocodificação.',
    example: 'Av. Corrientes 1234, Buenos Aires',
  }),
  address_raw: z.string().optional().openapi({
    description: 'Endereço bruto original (sem formatação).',
    example: 'Corrientes 1234',
  }),
  address_type: z.enum(['primary', 'secondary', 'service']).default('secondary').openapi({
    description: 'Tipo do endereço: primary (residência principal), secondary ou service.',
    example: 'secondary',
  }),
  display_order: z.number().int().positive().optional().openapi({
    description: 'Ordem de exibição (auto-incrementa se omitido).',
    example: 2,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/stats',
  tags: ['Admin · Patients'],
  summary: 'Estatísticas de pacientes',
  description:
    'Retorna contagens agregadas de pacientes por status e outros indicadores operacionais. ' +
    'Usado pelo dashboard administrativo.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Estatísticas de pacientes.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients',
  tags: ['Admin · Patients'],
  summary: 'Lista pacientes com filtros e paginação',
  description:
    'Retorna pacientes com filtros opcionais de status, busca textual e flag de atenção. ' +
    'Dados de PII (nome, diagnóstico) retornados conforme permissão RBAC.',
  security: [{ firebaseAuth: [] }],
  request: { query: AdminPatientsListQuery },
  responses: {
    200: { description: 'Lista paginada de pacientes.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Query params inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}',
  tags: ['Admin · Patients'],
  summary: 'Detalhes de um paciente',
  description:
    'Retorna dados completos do paciente: informações clínicas, responsáveis, endereços e vagas. ' +
    'Endpoint de leitura — sem side effects.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Dados do paciente.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Paciente não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

const PatientChatIdsBody = z.object({
  familyChatId: z.string().nullable().openapi({
    description: 'chat_id do grupo de WhatsApp da FAMÍLIA no Periskope. Só grupo (@g.us); null desvincula.',
    example: '120363001234567890@g.us',
  }),
  providersChatId: z.string().nullable().openapi({
    description: 'chat_id do grupo de WhatsApp dos PRESTADORES no Periskope. Só grupo (@g.us); null desvincula.',
    example: '5491112345678-1600000000@g.us',
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/chat-candidates',
  tags: ['Admin · Patients'],
  summary: 'Grupos do Periskope candidatos ao paciente',
  description:
    'Consulta os grupos de WhatsApp no Periskope (somente leitura, GET /chats) e devolve os mais ' +
    'parecidos com o nome do paciente, ordenados por score, marcando os que já estão vinculados a ' +
    'outro paciente. RANQUEIA, NUNCA ESCOLHE: qual é o da família e qual é o dos prestadores é ' +
    'decisão humana. Atrás do kill-switch PATIENT_CHAT_LOOKUP_ENABLED (503 quando desligado).',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    query: z.object({
      limit: z.coerce.number().optional().openapi({ description: 'Máximo de candidatos (1..50, default 10).', example: 10 }),
    }),
  },
  responses: {
    200: { description: 'Candidatos ranqueados.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Params/query inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Paciente não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    422: { description: 'Paciente sem nome — não há por onde ranquear.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: { description: 'Periskope indisponível.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    503: { description: 'Funcionalidade desligada (PATIENT_CHAT_LOOKUP_ENABLED).', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/patients/{id}/chat-ids',
  tags: ['Admin · Patients'],
  summary: 'Vincula os chat IDs de grupo (família / prestadores) ao paciente',
  description:
    'Grava o par de chat_ids de GRUPO do Periskope no paciente. Só aceita @g.us (conversa 1-1 @c.us ' +
    'é 400). Um mesmo grupo não pode ficar em dois pacientes: colisão devolve 409 CHAT_ID_ALREADY_LINKED. ' +
    'null desvincula.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: PatientChatIdsBody } } },
  },
  responses: {
    200: { description: 'Chat IDs gravados.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Body inválido (formato de chat_id, campo desconhecido, par igual).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Paciente não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    409: { description: 'chat_id já vinculado a outro paciente.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{patientId}/addresses',
  tags: ['Admin · Patients'],
  summary: 'Lista endereços do paciente',
  description:
    'Retorna todos os endereços cadastrados para o paciente ordenados por display_order. ' +
    'Inclui lat/lng quando disponível.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      patientId: z.string().uuid().openapi({ description: 'UUID do paciente.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
    }),
  },
  responses: {
    200: { description: 'Lista de endereços.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'patientId inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{patientId}/addresses',
  tags: ['Admin · Patients'],
  summary: 'Cria endereço para um paciente',
  description:
    'Adiciona um endereço ao paciente com geocodificação best-effort (lat/lng preenchido quando possível). ' +
    'Retorna 201 com os dados do endereço criado.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      patientId: z.string().uuid().openapi({ description: 'UUID do paciente.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
    }),
    body: { content: { 'application/json': { schema: CreatePatientAddressBody } } },
  },
  responses: {
    201: { description: 'Endereço criado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
