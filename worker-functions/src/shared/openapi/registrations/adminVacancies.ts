import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const VacancyListQuery = z.object({
  search: z.string().optional().openapi({ description: 'Busca textual por título ou caso.', example: 'Caso 766' }),
  status: z.string().optional().openapi({ description: 'Filtro por status da vaga.', example: 'SEARCHING' }),
  priority: z.string().optional().openapi({ description: 'Filtro por prioridade.', example: 'high' }),
  limit: z.coerce.number().optional().openapi({ description: 'Máximo de itens (default 20).', example: 20 }),
  offset: z.coerce.number().optional().openapi({ description: 'Itens a pular (default 0).', example: 0 }),
});

const CreateVacancyBody = z.object({
  patient_id: z.string().uuid().openapi({ description: 'UUID do paciente associado à vaga.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
  case_number: z.number().int().positive().openapi({ description: 'Número do caso clínico.', example: 766 }),
  patient_address_id: z.string().uuid().optional().openapi({ description: 'UUID do endereço do paciente.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
  required_professions: z.array(z.string()).optional().openapi({ description: 'Profissões requeridas.', example: ['AT', 'CUIDADOR'] }),
  required_sex: z.string().optional().openapi({ description: 'Sexo do worker preferido.', example: 'FEMALE' }),
  status: z.string().optional().openapi({ description: 'Status inicial da vaga.', example: 'PENDING_ACTIVATION' }),
  salary_text: z.string().optional().openapi({ description: 'Descrição textual do salário.', example: 'R$ 3.000/mês' }),
  work_schedule: z.string().optional().openapi({ description: 'Jornada de trabalho.', example: '8h às 18h, Seg-Sex' }),
});

const UpdateVacancyBody = z.object({
  status: z.enum(['SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CLOSED']).optional().openapi({
    description: 'Novo status da vaga.',
    example: 'SEARCHING',
  }),
  patient_address_id: z.string().uuid().optional().openapi({ description: 'Novo endereço do paciente.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
  salary_text: z.string().optional().openapi({ description: 'Descrição de salário.', example: 'R$ 3.500/mês' }),
  work_schedule: z.string().optional().openapi({ description: 'Jornada atualizada.', example: 'Integral' }),
}).openapi({ description: 'Campos permitidos para atualização de vaga.' });

const ResolveAddressBody = z.object({
  patient_address_id: z.string().uuid().optional().openapi({
    description: 'UUID de endereço existente para vincular à vaga.',
    example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91',
  }),
  createAddress: z.object({
    address_formatted: z.string().min(1).openapi({ description: 'Endereço formatado.', example: 'Av. Corrientes 1234, Buenos Aires' }),
    address_raw: z.string().optional().openapi({ description: 'Endereço bruto.', example: 'Corrientes 1234' }),
    address_type: z.string().min(1).openapi({ description: 'Tipo do endereço.', example: 'primary' }),
  }).optional().openapi({ description: 'Dados para criar novo endereço inline.' }),
}).openapi({ description: 'Vincula um endereço existente ou cria um novo para resolver a revisão pendente.' });

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies',
  tags: ['Admin · Vacancies'],
  summary: 'Lista vagas com filtros e paginação',
  description:
    'Retorna vagas com filtros opcionais de status, busca textual e prioridade. ' +
    'Ordenadas por data de criação decrescente.',
  security: [{ firebaseAuth: [] }],
  request: { query: VacancyListQuery },
  responses: {
    200: { description: 'Lista paginada de vagas.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/stats',
  tags: ['Admin · Vacancies'],
  summary: 'Estatísticas de vagas',
  description:
    'Retorna contagens de vagas por tempo em aberto, em seleção e total. ' +
    'Usado pelo dashboard operacional.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Estatísticas de vagas.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/next-vacancy-number',
  tags: ['Admin · Vacancies'],
  summary: 'Retorna próximo número de vaga',
  description:
    'Avança a sequence do banco e retorna o próximo vacancy_number disponível. ' +
    'Usado pelo form de criação de vaga antes de confirmar.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Próximo número disponível.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/cases-for-select',
  tags: ['Admin · Vacancies'],
  summary: 'Lista casos para dropdown de criação de vaga',
  description:
    'Retorna lista simplificada de pacientes com case_number para uso em seleção de caso no form de vaga. ' +
    'Filtra apenas pacientes ativos com endereço cadastrado.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Lista de casos para seleção.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/pending-address-review',
  tags: ['Admin · Vacancies'],
  summary: 'Lista vagas com revisão de endereço pendente',
  description:
    'Retorna vagas cujo patient_address_id não foi resolvido automaticamente no matching. ' +
    'Inclui dados de auditoria da tentativa de match.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      status: z.string().optional().openapi({ description: 'Filtro por status da vaga.', example: 'SEARCHING' }),
    }),
  },
  responses: {
    200: { description: 'Vagas pendentes de revisão de endereço.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/in-progress',
  tags: ['Admin · Vacancies'],
  summary: 'Lista vagas em progresso para um paciente',
  description:
    'Retorna vagas em status PENDING_ACTIVATION criadas via app (não sincronizadas com ClickUp) ' +
    'para o paciente informado. Usado para retomar criação interrompida.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      patient_id: z.string().uuid().openapi({ description: 'UUID do paciente.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
    }),
  },
  responses: {
    200: { description: 'Vagas em progresso.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'patient_id inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/{id}',
  tags: ['Admin · Vacancies'],
  summary: 'Detalhes de uma vaga',
  description:
    'Retorna dados completos da vaga: encuadres, publicações, endereço do paciente e dados clínicos. ' +
    'Endpoint de leitura — sem side effects.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Dados completos da vaga.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies',
  tags: ['Admin · Vacancies'],
  summary: 'Cria uma nova vaga',
  description:
    'Cria vaga com título auto-gerado "CASO {case}-{vacancy_number}". ' +
    'Dispara auto-match em background. O campo patient_id é obrigatório.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateVacancyBody } } } },
  responses: {
    201: { description: 'Vaga criada.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos ou paciente não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/vacancies/{id}',
  tags: ['Admin · Vacancies'],
  summary: 'Atualiza uma vaga',
  description:
    'Atualiza campos permitidos de uma vaga. Status precisa ser um dos valores canônicos. ' +
    'patient_id não pode ser removido.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: UpdateVacancyBody } } },
  },
  responses: {
    200: { description: 'Vaga atualizada.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/vacancies/{id}',
  tags: ['Admin · Vacancies'],
  summary: 'Encerra (soft-delete) uma vaga',
  description:
    'Muda o status da vaga para CLOSED. Não remove o registro do banco — operação reversível via PUT.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Vaga encerrada.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/{id}/resolve-address-review',
  tags: ['Admin · Vacancies'],
  summary: 'Resolve revisão de endereço de vaga',
  description:
    'Vincula um endereço existente ou cria um novo para resolver vagas em pendência de revisão de endereço. ' +
    'Valida que o endereço pertence ao paciente da vaga.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: ResolveAddressBody } } },
  },
  responses: {
    200: { description: 'Endereço vinculado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    422: { description: 'Endereço não pertence ao paciente.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
