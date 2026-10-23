import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

/**
 * Registro OpenAPI do pedido de substituição (spec 069, §3.3) — parte DIAS (`ONE_DAY`/`DAYS`). Arquivo PRÓPRIO (mesma razão dos
 * irmãos do itinerário). Tipo, período, nº de turnos, "quem entra" e "Sin cubrir" são DERIVADOS na leitura, nunca colunas. O
 * substituto de CADA turno é obrigatório e nullable no fio (P16): `null` = "Nadie todavía"; chave ausente = 400.
 */
const serviceParams = z.object({ id: z.string().uuid(), sid: z.string().uuid() });

const period = {
  type: z.enum(['ONE_DAY', 'DAYS']),
  outgoingWorkerId: z.string().uuid(),
  from: z.string().describe('YYYY-MM-DD'),
  to: z.string().optional().describe('YYYY-MM-DD. `ONE_DAY`: ausente ou igual a `from`. `DAYS`: obrigatório, `from <= to`, no máximo 92 dias.'),
};

const previewBody = z.object({ ...period, candidateWorkerIds: z.array(z.string().uuid()) }).strict();

const createBody = z
  .object({
    ...period,
    reasonCategory: z.string().nullish().describe('`code` de um item ATIVO do catálogo de motivos de saída (422 `REASON_REQUIRED` se ausente).'),
    shifts: z.array(
      z
        .object({
          date: z.string().describe('YYYY-MM-DD'),
          slotId: z.string().uuid(),
          substituteWorkerId: z.string().uuid().nullable().describe('OBRIGATÓRIO. `null` = "Nadie todavía" (o turno fica Sin cubrir).'),
        })
        .strict(),
    ).describe('EXATAMENTE os turnos da pessoa no período (os mesmos da pré-visão); outro conjunto = 422 `SUBSTITUTION_SHIFTS_MISMATCH`.'),
  })
  .strict();

const errors = {
  400: { description: 'params/query/body inválidos (inclui `substituteWorkerId` ausente num turno).', content: { 'application/json': { schema: ErrorResponseSchema } } },
  401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  403: { description: 'Sem a célula exigida pela rota.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  404: { description: 'Serviço inexistente, de outro paciente, ou fora da RLS.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
} as const;

const writeErrors = {
  ...errors,
  409: {
    description:
      '`ITINERARY_OVERLAP`: a data do substituto colide com outra alocação/ausência dele (gatilho do banco; o pedido INTEIRO falha, ' +
      'cabeçalho incluso). `ABSENCE_ALREADY_EXISTS`: já há falta aberta num dos turnos.',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  422: {
    description:
      '`REASON_REQUIRED`/`REASON_INVALID` (motivo), `ABSENCE_DATE_IN_PAST`, `SUBSTITUTION_NO_SHIFTS_IN_PERIOD` (a pessoa não tem turno ' +
      'no período), `SUBSTITUTION_SHIFTS_MISMATCH`, `NOT_SELECTED_FOR_SERVICE` (substituto fora do pool do step final da vacante), ' +
      '`SUBSTITUTE_IS_TITULAR`.',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
} as const;

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/substitution-requests',
  tags: ['Admin · Patients'],
  summary: 'Pedidos de substituição do serviço (Próximas × Pasadas)',
  description:
    'Query `when=upcoming|past` (padrão `upcoming`; pedido com algum turno de hoje em diante = Próximas). Uma linha por pedido, tudo ' +
    'DERIVADO (tipo `ONE_DAY|DAYS|PERMANENT`, período, nº de turnos, `entra` pela fonte única — substituto vivo da ausência ou alocação ' +
    'nova do REPLACE —, `adjusted`, `undoable`). Ausência anterior à migration 548 vem como linha `legacy` ("Sin pedido (anterior)"), ' +
    'sem motivo e sem desfazer. Nome de prestador só com `worker_contact:read`.',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceParams, query: z.object({ when: z.enum(['upcoming', 'past']).optional() }) },
  responses: { 200: { description: 'Pedidos.', content: { 'application/json': { schema: OkMessage } } }, ...errors },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/substitution-requests/outgoing-options',
  tags: ['Admin · Patients'],
  summary: '¿Quién no va a venir? — pessoas com alocação vigente ou futura no serviço',
  description: 'Uma linha por PESSOA (não por faixa): alocação `ACTIVE` com `valid_to` nulo ou de hoje em diante. `displayName` `null` sem `worker_contact:read`.',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceParams },
  responses: { 200: { description: 'Pessoas.', content: { 'application/json': { schema: OkMessage } } }, ...errors },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/substitution-requests/preview',
  tags: ['Admin · Patients'],
  summary: 'Pré-visão do pedido: turnos da pessoa, conflito por candidato × turno e estado do paciente',
  description:
    'LEITURA (nunca escreve; POST porque o corpo leva candidatos × período). Devolve `shifts` (data, faixa, início, fim — derivados no ' +
    'servidor), `conflicts[]` TRI-ESTADO por candidato × turno (`free` · `conflict` · `unknown`; `unknown` = a função do banco falhou e ' +
    'NUNCA vira `free`) e `statusAfter` (estado derivado do paciente depois do pedido; falta temporária não o move). Chama a MESMA ' +
    'montagem do gatilho da ausência (`itinerary_substitute_conflict_preview`).',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceParams, body: { content: { 'application/json': { schema: previewBody } } } },
  responses: { 200: { description: 'Pré-visão.', content: { 'application/json': { schema: OkMessage } } }, ...writeErrors },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/substitution-requests',
  tags: ['Admin · Patients'],
  summary: 'Criar o pedido de substituição por dias (Un solo día / Varios días)',
  description:
    'UMA transação: cabeçalho → N ausências → N registros `ABSENCE` do log, todos com o mesmo `request_id`. Qualquer falha (ex.: 23P01 no ' +
    '3º turno) desfaz tudo. Não move o paciente. O "No vuelve más" é outra operação (F3).',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceParams, body: { content: { 'application/json': { schema: createBody } } } },
  responses: { 201: { description: 'Criado.', content: { 'application/json': { schema: OkMessage } } }, ...writeErrors },
});
