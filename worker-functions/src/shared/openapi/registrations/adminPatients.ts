import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';
import { PATIENT_CHAT_ROLE_PATTERN } from '@modules/case';

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

/**
 * Body de PUT /chat-ids — um MAPA ABERTO de papel -> chat_id.
 *
 * A doc descreve a FORMA da chave, não a lista de papéis: quais papéis existem é
 * DADO (`patient_chat_roles`, administrado em /admin/patient-chat-roles), e
 * enumerá-los aqui faria a doc mentir no instante em que alguém criasse um papel
 * pela tela. Quem quer a lista viva chama GET /api/admin/patient-chat-roles.
 */
const PatientChatIdsBody = z.object({
  chatIds: z
    .record(
      z.string().regex(PATIENT_CHAT_ROLE_PATTERN),
      z.string().nullable().openapi({ example: '120363001234567890@g.us' }),
    )
    .openapi({
      description:
        'Objeto com o CÓDIGO DO PAPEL na chave (INGLÊS MAIÚSCULO — FAMILY, PROVIDERS, ' +
        'HEALTH_PLAN, ou qualquer outro criado na tela de papéis) e o chat_id do grupo no ' +
        'valor. Só grupo (@g.us). null DESVINCULA; papel AUSENTE do objeto fica INALTERADO. ' +
        'Papel fora do catálogo ativo é 400 UNKNOWN_CHAT_ROLE.',
      example: { FAMILY: '120363001234567890@g.us', PROVIDERS: null },
    }),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/chat-map',
  tags: ['Admin · Patients'],
  summary: 'Mapa Postgres ↔ ClickUp ↔ Periskope (em massa)',
  description:
    'Devolve, para vários pacientes de uma vez, o patientId + clickupTaskId + `chatIds` ' +
    '(objeto papel -> chat_id de grupo do WhatsApp). É a chave de join da auditoria de informes. ' +
    'filter=linked (default) traz quem já tem vínculo; filter=unlinked é a fila do backfill. ' +
    '?chatId= faz a busca REVERSA (de qual paciente é este grupo, e em qual papel). ' +
    'SÓ IDENTIFICADORES: nunca nome, telefone ou documento do paciente.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      filter: z.enum(['linked', 'unlinked', 'all']).optional().openapi({ description: 'Recorte (default linked).', example: 'unlinked' }),
      chatId: z.string().optional().openapi({ description: 'Busca reversa por chat_id de grupo (@g.us).', example: '120363001234567890@g.us' }),
      limit: z.coerce.number().optional().openapi({ description: 'Tamanho da página (1..1000, default 500).', example: 500 }),
      offset: z.coerce.number().optional().openapi({ description: 'Linhas a pular (default 0).', example: 0 }),
    }),
  },
  responses: {
    200: { description: 'Mapa paginado (patients, total, limit, offset, hasMore).', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Query inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/chat-candidates',
  tags: ['Admin · Patients'],
  summary: 'Grupos do Periskope candidatos ao paciente',
  description:
    'Consulta os grupos de WhatsApp no Periskope (somente leitura, GET /chats) e devolve os mais ' +
    'parecidos com o nome do paciente, ordenados por score, marcando os que já estão vinculados a ' +
    'outro paciente. RANQUEIA, NUNCA ESCOLHE: qual grupo pertence a qual papel é ' +
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
  summary: 'Vincula os chat IDs de grupo do paciente, por papel',
  description:
    'Grava os chat_ids de GRUPO do Periskope no paciente, um por papel. Os papéis válidos vêm do ' +
    'CATÁLOGO (GET /api/admin/patient-chat-roles), não de uma lista em código — papel fora do ' +
    'catálogo ativo é 400 UNKNOWN_CHAT_ROLE. Só aceita @g.us (conversa 1-1 @c.us é 400). ' +
    'Um mesmo grupo não pode ficar em dois pacientes quando o papel é EXCLUSIVO: colisão devolve ' +
    '409 CHAT_ID_ALREADY_LINKED. null desvincula; papel ausente fica inalterado. ' +
    'O body legado { familyChatId, providersChatId } (migration 260) continua aceito e é ' +
    'traduzido para FAMILY/PROVIDERS — sai com a migration de contract.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: PatientChatIdsBody } } },
  },
  responses: {
    200: { description: 'Chat IDs gravados.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Body inválido (formato de chat_id, papel desconhecido, mesmo grupo em dois papéis).', content: { 'application/json': { schema: ErrorResponseSchema } } },
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

// ── CATÁLOGO de papéis de chat (migration 262) ───────────────────────────────
// Leitura é staff (a ficha do paciente precisa dos rótulos); escrita é ADMIN.

const RoleCodeParam = z
  .string()
  .regex(PATIENT_CHAT_ROLE_PATTERN)
  .openapi({ description: 'Código do papel (INGLÊS MAIÚSCULO).', example: 'HEALTH_PLAN' });

const PatientChatRoleBody = z.object({
  code: RoleCodeParam,
  labelEs: z.string().openapi({ description: 'Rótulo em espanhol (obrigatório).', example: 'Grupo de la obra social' }),
  labelPtBr: z.string().openapi({ description: 'Rótulo em pt-BR (obrigatório).', example: 'Grupo do plano de saúde' }),
  isExclusive: z.boolean().optional().openapi({
    description:
      'true (default) = um grupo deste papel pertence a NO MÁXIMO um paciente — é a trava que ' +
      'impede a auditoria de contar a mesma conversa duas vezes. false = compartilhável entre ' +
      'pacientes (caso do grupo por pagador).',
    example: true,
  }),
  displayOrder: z.number().int().optional().openapi({ description: 'Ordem na tela.', example: 3 }),
  matchKeywords: z.array(z.string()).optional().openapi({
    description:
      'Palavras que identificam este papel no NOME do grupo ("flia" × "equipo"). Usadas SÓ para ' +
      'DESEMPATAR o ranqueamento de candidatos — nunca para escolher sozinho.',
    example: ['obra', 'social', 'prepaga'],
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patient-chat-roles',
  tags: ['Admin · Patients'],
  summary: 'Catálogo de papéis de grupo de WhatsApp do paciente',
  description:
    'Lista os papéis (FAMILY, PROVIDERS, HEALTH_PLAN e os que a administração criar). Sem query, ' +
    'devolve só os ATIVOS — o que a ficha do paciente exibe e o que se pode gravar. ' +
    '?includeInactive=true devolve todos MAIS `usage` (quantos pacientes usam cada papel), que é a ' +
    'visão da tela de administração.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      includeInactive: z.enum(['true', 'false']).optional().openapi({
        description: 'Inclui papéis desativados e a contagem de uso. Visão de administração.',
        example: 'true',
      }),
    }),
  },
  responses: {
    200: { description: 'Catálogo de papéis.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Query inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patient-chat-roles',
  tags: ['Admin · Patients'],
  summary: 'Cria um papel no catálogo (ADMIN)',
  description:
    'Cria um papel novo. Nenhuma migration: o catálogo é dado. `code` é imutável depois de criado — ' +
    'trocá-lo renomearia a chave de join da auditoria sem ninguém perceber.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: PatientChatRoleBody } } } },
  responses: {
    201: { description: 'Papel criado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Body inválido (forma do código, rótulo em branco).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Requer admin.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    409: { description: 'CHAT_ROLE_ALREADY_EXISTS — já existe papel com este código.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/admin/patient-chat-roles/{code}',
  tags: ['Admin · Patients'],
  summary: 'Edita um papel do catálogo (ADMIN)',
  description:
    'Campo ausente fica INALTERADO. Duas recusas com número, que nunca são silenciosas: ' +
    '(a) virar `isExclusive` de false para true quando já existe grupo repetido entre pacientes → ' +
    '409 CHAT_ROLE_EXCLUSIVITY_CONFLICT com a lista de grupos e a contagem de pacientes (o software ' +
    'não escolhe qual paciente perde o vínculo); (b) `isActive: false` em papel em uso → ' +
    '409 CHAT_ROLE_IN_USE com quantos pacientes dependem. Nada de cascata. ' +
    'Virar a política atualiza `patient_chat_ids.is_exclusive` na MESMA transação — senão o índice ' +
    'parcial ficaria trancando um papel que a tela diz ser compartilhável.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ code: RoleCodeParam }),
    body: { content: { 'application/json': { schema: PatientChatRoleBody.omit({ code: true }).extend({ isActive: z.boolean().optional() }).partial() } } },
  },
  responses: {
    200: { description: 'Papel atualizado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Body inválido ou vazio.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Requer admin.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'CHAT_ROLE_NOT_FOUND.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    409: { description: 'CHAT_ROLE_IN_USE ou CHAT_ROLE_EXCLUSIVITY_CONFLICT — sempre com a contagem.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/patient-chat-roles/{code}',
  tags: ['Admin · Patients'],
  summary: 'Apaga um papel do catálogo (ADMIN)',
  description:
    'Só apaga papel que NENHUM paciente usa — em uso é 409 CHAT_ROLE_IN_USE com a contagem. Os ' +
    'vínculos são a chave de join da auditoria; apagá-los junto com uma linha de catálogo seria ' +
    'perder dado operacional por um clique de configuração. Para tirar da tela sem perder ' +
    'histórico, use `isActive: false`.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ code: RoleCodeParam }) },
  responses: {
    204: { description: 'Papel apagado.' },
    400: { description: 'Código inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Requer admin.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'CHAT_ROLE_NOT_FOUND.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    409: { description: 'CHAT_ROLE_IN_USE — quantos pacientes dependem.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/chat-groups',
  tags: ['Admin · Patients'],
  summary: 'Todos os grupos de WhatsApp que a org enxerga, com busca',
  description:
    'Lista os grupos do Periskope de TODOS os números conectados da org, com busca por nome. ' +
    'NÃO é escopado a paciente — responde "qual é o grupo da obra social?", que o ' +
    '/patients/{id}/chat-candidates não pode responder: lá o ranqueamento é por semelhança com o ' +
    'NOME DO PACIENTE e descarta score zero, e o grupo do pagador (`Gestión: EnLite <> DAS`) não se ' +
    'parece com paciente nenhum. Cada linha traz `linkedPatientCount` (quantos pacientes já usam o ' +
    'grupo — num papel compartilhado é o esperado, num exclusivo significa 409 na gravação) e ' +
    '`orgPhone` (de qual número conectado o grupo veio, que é o que explica um grupo não aparecer: ' +
    'grupo em que nenhum número nosso está não existe para nós). ' +
    'Atrás do kill-switch PATIENT_CHAT_LOOKUP_ENABLED (503 quando desligado). Somente leitura.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      search: z.string().optional().openapi({
        description: 'Filtro por NOME do grupo, sem acento e sem caixa. Vazio = todos.',
        example: 'gestion',
      }),
      limit: z.coerce.number().optional().openapi({ description: 'Tamanho da página (1..200, default 50).', example: 20 }),
      offset: z.coerce.number().optional().openapi({ description: 'Linhas a pular (default 0).', example: 0 }),
    }),
  },
  responses: {
    200: { description: 'Página de grupos (groups, total, limit, offset, hasMore, listTruncated).', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Query inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: { description: 'Periskope indisponível — diferente de "achei zero".', content: { 'application/json': { schema: ErrorResponseSchema } } },
    503: { description: 'Funcionalidade desligada (PATIENT_CHAT_LOOKUP_ENABLED).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
