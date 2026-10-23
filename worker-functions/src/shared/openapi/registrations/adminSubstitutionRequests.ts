import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

/**
 * Registro OpenAPI do pedido de substituição (spec 069, §3.3) — DIAS (`ONE_DAY`/`DAYS`), "No vuelve más" (`PERMANENT`), desfazer e "Elegir quién entra". Arquivo PRÓPRIO (mesma razão dos
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

const permanentPeriod = {
  type: z.literal('PERMANENT'),
  outgoingWorkerId: z.string().uuid(),
  from: z.string().describe('YYYY-MM-DD — D, o primeiro dia SEM a pessoa (sem `to`: sem fim).'),
};

const previewBody = z.union([
  z.object({ ...period, candidateWorkerIds: z.array(z.string().uuid()) }).strict(),
  z.object({ ...permanentPeriod, candidateWorkerIds: z.array(z.string().uuid()) }).strict(),
]);

const createPermanentBody = z
  .object({
    ...permanentPeriod,
    reasonCategory: z.string().nullish().describe('`code` de um item ATIVO do catálogo de motivos de saída (422 `REASON_REQUIRED` se ausente).'),
    destination: z.string().nullish().describe('`RESERVE` | `LEAVE_SERVICE`. Só é perguntado com D = hoje (422 `DESTINATION_REQUIRED`); com D > hoje grava `RESERVE` e `LEAVE_SERVICE` é 422 `DESTINATION_NOT_AVAILABLE_FOR_SCHEDULED`.'),
    substituteWorkerId: z.string().uuid().nullable().describe('OBRIGATÓRIO. uuid = quem entra no lugar dela em TODAS as faixas; `null` = ninguém ainda (saída sem substituto).'),
  })
  .strict();

const createDaysBody = z
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

const createBody = z.union([createDaysBody, createPermanentBody]);

const requestParams = serviceParams.extend({ rid: z.string().uuid() });
const coverBody = z.object({ substituteWorkerId: z.string().uuid() }).strict();

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
      'cabeçalho incluso). `ABSENCE_ALREADY_EXISTS`: já há falta aberta num dos turnos. `WORKER_HAS_PENDING_ENTRY` (P5): a pessoa tem ' +
      'entrada futura no serviço — desfaça o pedido que a trouxe. `REQUEST_ALREADY_UNDONE` / `REQUEST_NOT_UNDOABLE` (nada futuro a ' +
      'desfazer) / `NOTHING_TO_COVER` / `ALLOCATION_RESTORE_CONFLICT` (o titular já tem alocação aberta na faixa — defeito 17).',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  422: {
    description:
      '`REASON_REQUIRED`/`REASON_INVALID` (motivo), `ABSENCE_DATE_IN_PAST`, `SUBSTITUTION_NO_SHIFTS_IN_PERIOD` (a pessoa não tem turno ' +
      'no período), `SUBSTITUTION_SHIFTS_MISMATCH`, `NOT_SELECTED_FOR_SERVICE` (substituto fora do pool do step final da vacante), ' +
      '`SUBSTITUTE_IS_TITULAR`, `DESTINATION_REQUIRED` / `DESTINATION_NOT_AVAILABLE_FOR_SCHEDULED` (permanente), `ALREADY_ALLOCATED_IN_SLOT`, ' +
      '`ALLOCATION_NOT_ACTIVE`, `SERVICE_TEAM_WORKER_ALLOCATED`.',
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
    'montagem do gatilho da ausência (`itinerary_substitute_conflict_preview`). `PERMANENT`: `shifts` = UM por alocação que sai a partir ' +
    'de D, conflito com vigência ABERTA, `statusAfter` = estado SE NINGUÉM entrar, e `permanent` = `{allocationCount, cancelledAbsences, ' +
    'clearedSubstitutes, pendingEntry}` (FR-23, P5).',
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
    '3º turno) desfaz tudo. DIAS não move o paciente. `PERMANENT` ("No vuelve más"): para cada alocação da pessoa no serviço, com ' +
    'substituto `replaceWith` + `REPLACE`, sem substituto fim em D−1 (ou cancela a que só começa em D) + `REMOVE`; FR-23 cancela as faltas ' +
    'dela e limpa onde ela era substituta com `on_date ≥ D`; a derivação do estado roda UMA vez no fim.',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceParams, body: { content: { 'application/json': { schema: createBody } } } },
  responses: { 201: { description: 'Criado.', content: { 'application/json': { schema: OkMessage } } }, ...writeErrors },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/substitution-requests/{rid}/undo',
  tags: ['Admin · Patients'],
  summary: 'Desfazer o pedido de substituição (Deshacer)',
  description:
    'UMA transação, nunca DELETE. DIAS: cancela as ausências do pedido de hoje em diante (dias passados intocados). PERMANENTE (só ANTES ' +
    'de D): cancela as entradas dos substitutos e SÓ DEPOIS solta o fim do titular ou o restaura. As faltas canceladas pelo "No vuelve ' +
    'más" não voltam. 409 `REQUEST_ALREADY_UNDONE` / `REQUEST_NOT_UNDOABLE` / `ALLOCATION_RESTORE_CONFLICT`.',
  security: [{ firebaseAuth: [] }],
  request: { params: requestParams },
  responses: { 200: { description: 'Desfeito.', content: { 'application/json': { schema: OkMessage } } }, ...writeErrors },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/substitution-requests/{rid}/cover',
  tags: ['Admin · Patients'],
  summary: 'Elegir quién entra — uma pessoa para os turnos do pedido que ficaram sem ninguém',
  description:
    'DIAS: põe o substituto em cada ausência futura do pedido sem substituto (mesmo gate e mesmo gatilho do substituto avulso). ' +
    'PERMANENTE sem substituto: aloca a pessoa nas faixas liberadas a partir de `max(D, hoje)` e grava `REPLACE` com o `request_id`. ' +
    '409 `NOTHING_TO_COVER` se não há nada sem ninguém.',
  security: [{ firebaseAuth: [] }],
  request: { params: requestParams, body: { content: { 'application/json': { schema: coverBody } } } },
  responses: { 200: { description: 'Coberto.', content: { 'application/json': { schema: OkMessage } } }, ...writeErrors },
});
