import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const WorkerInitBody = z.object({
  authUid: z.string().min(1).openapi({ description: 'UID do Firebase Auth do worker.', example: 'uid_abc123' }),
  email: z.string().email().openapi({ description: 'E-mail do worker.', example: 'worker@example.com' }),
  phone: z.string().optional().openapi({ description: 'Telefone em formato E.164.', example: '+5491112345678' }),
  country: z.string().length(2).default('AR').openapi({ description: 'Código ISO 3166-1 alpha-2 do país.', example: 'AR' }),
});

const WorkerStepBody = z.object({
  workerId: z.string().min(1).openapi({ description: 'UUID do worker.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
  step: z.number().int().openapi({ description: 'Número do step de onboarding (0-based).', example: 1 }),
  data: z.record(z.unknown()).openapi({ description: 'Payload do step — campos variam por etapa.' }),
});

const WorkerGeneralInfoBody = z.object({
  firstName: z.string().optional().openapi({ description: 'Primeiro nome.', example: 'João' }),
  lastName: z.string().optional().openapi({ description: 'Sobrenome.', example: 'Silva' }),
  birthDate: z.string().optional().openapi({ description: 'Data de nascimento ISO.', example: '1990-05-15' }),
  sex: z.string().optional().openapi({ description: 'Sexo biológico canonical UPPERCASE.', example: 'MALE' }),
  documentNumber: z.string().optional().openapi({ description: 'Número de documento (DNI/CPF).', example: '12345678' }),
});

const WorkerServiceAreaBody = z.object({
  zones: z.array(z.string()).optional().openapi({ description: 'Lista de zonas de atendimento.', example: ['Palermo', 'Belgrano'] }),
  radius_km: z.number().optional().openapi({ description: 'Raio máximo de deslocamento em km.', example: 15 }),
});

const WorkerAvailabilityBody = z.object({
  availability: z.record(z.unknown()).openapi({
    description: 'Mapa de disponibilidade por dia/turno.',
    example: { monday: ['morning', 'afternoon'], friday: ['evening'] },
  }),
});

export const WorkerProfileSchema = registry.register(
  'WorkerProfile',
  z.object({
    id: UuidParam,
    email: z.string().email().openapi({ example: 'worker@example.com' }),
    status: z.string().openapi({ example: 'INCOMPLETE_REGISTER' }),
    step: z.number().int().optional().openapi({ example: 2 }),
    /**
     * O que falta para o cadastro ficar completo, segundo `fn_worker_missing_fields`
     * — a MESMA função que decide se a postulação passa (D302).
     *
     * `[]`   = apurei e nada falta.
     * `null` = NÃO consegui apurar. É "não sei", nunca "está completo": o cliente
     *          tem de tratar como desconhecido (fail-closed).
     */
    // NÃO é `.optional()`: `withMissingFields` sempre emite a chave, e um
    // terceiro estado (`undefined`) na spec daria a um cliente gerado o
    // `if (!missingFields?.length) → "completo"` — a D302 renascendo por uma
    // porta nova. Dois estados, e só: `[]` = nada falta · `null` = não apurei.
    missingFields: z.array(z.string()).nullable().openapi({
      example: ['phone', 'title_certificate'],
      description: '[] = nada falta · null = não foi possível apurar (NÃO significa completo)',
    }),
  }).openapi({ description: 'Dados do worker autenticado, com o veredito de completude.' }),
);

/**
 * Ramo degradado do 200 do `PUT /me/general-info`: a escrita ACONTECEU, mas a
 * releitura que a confirmaria falhou. `missingFields: null` mantém o contrato —
 * "gravei, mas não sei te dizer o estado", nunca "está completo".
 */
export const UnconfirmedWrite = registry.register(
  'UnconfirmedWrite',
  z.object({
    message: z.string().openapi({ example: 'General info saved' }),
    missingFields: z.null().openapi({ description: 'Sempre null: não foi possível apurar.' }),
  }).openapi({ description: 'Escrita gravada mas não confirmada.' }),
);

/**
 * O `200` do `PUT /me/general-info` — os DOIS ramos, numa constante só.
 *
 * Exportada de propósito: o `registerPath` abaixo e o teste de contrato usam
 * ESTA constante. Se o teste remontasse a união por conta própria, ficaria verde
 * mesmo se alguém trocasse o `schema` da rota de volta para só o perfil — foi
 * exatamente o que a sabotagem S4 do gate (rodada 4) provou da 1ª versão.
 */
export const WorkerGeneralInfoOk200 = z.union([WorkerProfileSchema, UnconfirmedWrite]);

registry.registerPath({
  method: 'post',
  path: '/api/workers/init',
  tags: ['Worker · Onboarding'],
  summary: 'Inicializa conta de worker',
  description:
    'Cria o registro de worker a partir do Firebase ID token. Idempotente — se já existir retorna o existente. ' +
    'Não requer autenticação prévia; o `authUid` deve bater com o token Firebase.',
  security: [],
  request: { body: { content: { 'application/json': { schema: WorkerInitBody } } } },
  responses: {
    201: { description: 'Worker criado com sucesso.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Campos obrigatórios ausentes ou dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/lookup',
  tags: ['Worker · Onboarding'],
  summary: 'Busca worker por e-mail',
  description:
    'Verifica se já existe cadastro para o e-mail informado. Rate-limited a 10 req/min. ' +
    'Público — não exige autenticação.',
  security: [],
  request: {
    query: z.object({
      email: z.string().email().openapi({ description: 'E-mail do worker a buscar.', example: 'worker@example.com' }),
    }),
  },
  responses: {
    200: { description: 'Resultado do lookup.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'E-mail inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/workers/step',
  tags: ['Worker · Profile'],
  summary: 'Salva step de onboarding',
  description:
    'Persiste um step do fluxo de cadastro do worker. Requer Firebase token. ' +
    'O campo `step` é um inteiro crescente; o payload `data` varia por etapa.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: WorkerStepBody } } } },
  responses: {
    200: { description: 'Step salvo.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/me',
  tags: ['Worker · Profile'],
  summary: 'Retorna perfil do worker autenticado',
  description:
    'Retorna os dados do worker logado via Firebase token. ' +
    'Inclui status de cadastro e progresso de onboarding.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Perfil do worker.', content: { 'application/json': { schema: WorkerProfileSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/workers/me/general-info',
  tags: ['Worker · Profile'],
  summary: 'Atualiza informações gerais do worker',
  description:
    'Atualiza campos pessoais do worker autenticado (nome, data de nascimento, documento, etc.). ' +
    'Dados sensíveis são armazenados encriptados via KMS.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: WorkerGeneralInfoBody } } } },
  responses: {
    200: {
      // ESCRITA CONFIRMADA (D302): devolve o cadastro como o BANCO ficou, relido
      // pelo mesmo caminho do GET — não um "salvo com sucesso" que o cliente
      // teria de acreditar.
      //
      // São DOIS ramos de 200, e o schema declara os dois de propósito: se a
      // releitura pós-escrita falhar, a gravação ACONTECEU mas não pôde ser
      // confirmada, e a rota devolve `{ message, missingFields: null }` — sem
      // perfil. Declarar só o perfil faria a spec mentir exatamente no ramo que
      // esta mudança existe para tornar honesto.
      description:
        'Informações atualizadas. Devolve o cadastro relido; se a releitura falhar, ' +
        'devolve confirmação sem perfil com missingFields: null (gravou, não confirmou).',
      content: { 'application/json': { schema: WorkerGeneralInfoOk200 } },
    },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    409: {
      description: 'Telefone pertence a outra conta (PHONE_NOT_AVAILABLE).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/workers/me/service-area',
  tags: ['Worker · Profile'],
  summary: 'Atualiza área de atendimento do worker',
  description:
    'Define as zonas geográficas e raio máximo de deslocamento do worker. ' +
    'Usado no algoritmo de matching para filtrar candidatos por proximidade.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: WorkerServiceAreaBody } } } },
  responses: {
    200: { description: 'Área de atendimento atualizada.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/me/availability',
  tags: ['Worker · Profile'],
  summary: 'Retorna disponibilidade do worker',
  description:
    'Retorna a grade de disponibilidade semanal do worker autenticado (dias e turnos). ' +
    'Requer Firebase token.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Disponibilidade do worker.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/workers/me/availability',
  tags: ['Worker · Profile'],
  summary: 'Atualiza disponibilidade do worker',
  description:
    'Persiste a grade de disponibilidade semanal do worker. ' +
    'Impacta o matching de vagas disponíveis.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: WorkerAvailabilityBody } } } },
  responses: {
    200: { description: 'Disponibilidade salva.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
