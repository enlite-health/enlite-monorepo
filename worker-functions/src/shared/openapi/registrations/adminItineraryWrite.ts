import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

/**
 * Registro OpenAPI dos 10 escritores do itinerário — Fase 11 (7, DX-11.9) + Fase 13 (3, DX-13.8: a
 * substituição pontual). Arquivo PRÓPRIO (mesma razão do quadro C e do agregado do Kanban:
 * `adminPatients.ts` já tem 436 linhas > 400 — regra do CLAUDE.md do monorepo). A trava de
 * sobreposição é do banco; 409 traz os dois horários e, entre endereços, a folga; não move o
 * paciente.
 */
const serviceParams = z.object({ id: z.string().uuid(), sid: z.string().uuid() });
const slotParams = serviceParams.extend({ slotId: z.string().uuid() });
const allocationParams = serviceParams.extend({ allocationId: z.string().uuid() });
const patientParams = z.object({ id: z.string().uuid() });
const substituteParams = serviceParams.extend({ absenceId: z.string().uuid() });

const slotBody = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string(),
  endTime: z.string(),
});

const allocationBody = z.object({ workerId: z.string().uuid() });

const absenceBody = z.object({
  date: z.string(),
  substituteWorkerId: z.string().uuid().optional(),
});

const endBody = z.object({
  reasonCategory: z.string().describe('`code` de um item ATIVO do catálogo de motivos de saída.'),
  destination: z.enum(['RESERVE', 'LEAVE_SERVICE']).describe('`RESERVE`: segue como reserva (Selecionado). `LEAVE_SERVICE`: sai do encuadre deste serviço (marca de rejeição com o mesmo motivo).'),
});

const substituteBody = z.object({ substituteWorkerId: z.string().uuid().nullable() });

const commonErrors = {
  400: { description: 'params/body inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  403: { description: 'Sem a célula exigida pela rota.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  404: {
    description: 'Serviço, slot, alocação ou paciente inexistente, de outro paciente, ou fora da RLS.',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  409: {
    description:
      'Dois códigos possíveis. `ITINERARY_OVERLAP`: sobreposição de horário na ALOCAÇÃO — a trava é do banco; a ' +
      'resposta traz os dois horários e, quando o conflito é entre endereços diferentes, a folga mínima. ' +
      '`SLOT_ALREADY_EXISTS`: a chave (dia/horário) já está ativa em outro slot do mesmo serviço — devolvido tanto ' +
      'ao CRIAR quanto ao EDITAR (PATCH) um slot.',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  422: {
    description:
      'Endereço ausente no serviço, slot inativo/com alocação ativa vigente, prestador fora de Selecionado (C) do ' +
      'serviço, ou nenhum/algum serviço com vaga viva sem slot montável.',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
} as const;

const readResponses = {
  200: { description: 'Opções de alocação: o `selected` do quadro C deste serviço.', content: { 'application/json': { schema: OkMessage } } },
  ...commonErrors,
} as const;

const createResponses = {
  201: { description: 'Criado.', content: { 'application/json': { schema: OkMessage } } },
  ...commonErrors,
} as const;

const actionResponses = {
  200: { description: 'Atualizado.', content: { 'application/json': { schema: OkMessage } } },
  ...commonErrors,
} as const;

// ── Substituição pontual (Fase 13, DX-13.8) ──────────────────────────────────────────────────
const absenceErrors = {
  400: commonErrors[400],
  401: commonErrors[401],
  403: commonErrors[403],
  404: {
    description: 'Alocação ou ausência inexistente, de outro paciente, ou fora da RLS.',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  409: {
    description:
      'Dois códigos possíveis. `ITINERARY_OVERLAP`: a data do substituto colide com outra alocação/ausência dele — ' +
      'a trava é do banco; a resposta traz os dois horários e, entre endereços, a folga mínima. ' +
      '`ABSENCE_ALREADY_EXISTS`: já há uma ausência aberta nesta alocação/data.',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  422: {
    description:
      'Alocação não ativa, prestador fora de Selecionado (C) do serviço, data passada, ausência já cancelada, ' +
      'data fora da vigência da alocação, data fora do dia da semana do slot, ou o substituto é o próprio titular.',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  500: commonErrors[500],
} as const;

const absenceCreateResponses = {
  201: { description: 'Registrada.', content: { 'application/json': { schema: OkMessage } } },
  ...absenceErrors,
} as const;

const absenceActionResponses = {
  200: { description: 'Atualizada.', content: { 'application/json': { schema: OkMessage } } },
  ...absenceErrors,
} as const;

/** As 3 descrições repetem o texto literal pedido no plano — a ausência é sempre a mesma operação. */
const ABSENCE_DESCRIPTION =
  'Registra a ausência do titular num dia (sem motivo: pode ser clínico); substituto opcional, de Selecionado (C); ' +
  'a trava por data é do banco; não move o paciente nem as horas.';

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/allocation-options',
  tags: ['Admin · Patients'],
  summary: 'Opções de alocação: prestadores em Selecionado (C) deste serviço contratado',
  description: 'Calculado a partir do mesmo `GetServiceTeamUseCase` do quadro C — nunca uma 2ª definição de Selecionado.',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceParams },
  responses: readResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/itinerary/slots',
  tags: ['Admin · Patients'],
  summary: 'Criar uma faixa semanal (slot) do itinerário do serviço',
  description:
    'Edita o `schedule` do serviço e reusa `syncItinerarySlots` na mesma transação — a trava de sobreposição é do ' +
    'banco; 409 traz os dois horários e, entre endereços, a folga mínima. Não move o paciente.',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceParams, body: { content: { 'application/json': { schema: slotBody } } } },
  responses: createResponses,
});

registry.registerPath({
  method: 'patch',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/itinerary/slots/{slotId}',
  tags: ['Admin · Patients'],
  summary: 'Editar a faixa semanal (slot) do itinerário',
  description:
    'Troca a chave (dia/horário) do slot pela nova, reescrevendo o `schedule`. Recusa se o slot tiver alocação ' +
    'ativa vigente (encerre-a primeiro). A trava de sobreposição é do banco; não move o paciente.',
  security: [{ firebaseAuth: [] }],
  request: { params: slotParams, body: { content: { 'application/json': { schema: slotBody } } } },
  responses: actionResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/itinerary/slots/{slotId}/end',
  tags: ['Admin · Patients'],
  summary: 'Encerrar a faixa semanal (slot) do itinerário',
  description: 'Remove a chave do `schedule` do serviço. Recusa se o slot tiver alocação ativa vigente. Não move o paciente.',
  security: [{ firebaseAuth: [] }],
  request: { params: slotParams },
  responses: actionResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/itinerary/slots/{slotId}/allocations',
  tags: ['Admin · Patients'],
  summary: 'Alocar um prestador de Selecionado (C) num slot do itinerário',
  description:
    'Exige que o prestador esteja em Selecionado (C) daquele serviço (ou Em Atendimento no mesmo AT, segunda porta). ' +
    'A trava de sobreposição é do banco: 409 traz os dois horários e, entre endereços, a folga mínima. Não move o ' +
    'paciente nem a candidatura na vaga.',
  security: [{ firebaseAuth: [] }],
  request: { params: slotParams, body: { content: { 'application/json': { schema: allocationBody } } } },
  responses: createResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/itinerary/allocations/{allocationId}/end',
  tags: ['Admin · Patients'],
  summary: 'Tirar um prestador do itinerário, com motivo e destino (Fase 4)',
  description:
    'Corpo obrigatório `{ reasonCategory, destination }`. Numa só transação: encerra a alocação (o prestador volta a ' +
    'Selecionado por derivação), grava o registro de trocas (`REMOVE`) e, com `LEAVE_SERVICE`, a marca de rejeição com o ' +
    'mesmo motivo; depois deriva o estado do paciente. `RESERVE` não grava marca. 422: `REASON_REQUIRED`, ' +
    '`REASON_INVALID`, `DESTINATION_REQUIRED`, `ALLOCATION_NOT_ACTIVE` e `SERVICE_TEAM_WORKER_ALLOCATED` (`LEAVE_SERVICE` ' +
    'de quem tem atenciones agendadas: nada é gravado).',
  security: [{ firebaseAuth: [] }],
  request: { params: allocationParams, body: { content: { 'application/json': { schema: endBody } } } },
  responses: actionResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/itinerary/assemble',
  tags: ['Admin · Patients'],
  summary: 'Marcar o itinerário do paciente como montado',
  description:
    'Log append-only (`patient_itinerary_assembly`) — marcar de novo grava linha nova, nunca reescreve. Recusa se ' +
    'nenhum serviço com vaga viva existir, ou se algum serviço com vaga viva ainda não tiver slot ativo. Não move o paciente.',
  security: [{ firebaseAuth: [] }],
  request: { params: patientParams },
  responses: createResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/itinerary/allocations/{allocationId}/absences',
  tags: ['Admin · Patients'],
  summary: 'Registrar a ausência pontual do titular num dia, com substituto opcional (Fase 13)',
  description: ABSENCE_DESCRIPTION,
  security: [{ firebaseAuth: [] }],
  request: { params: allocationParams, body: { content: { 'application/json': { schema: absenceBody } } } },
  responses: absenceCreateResponses,
});

registry.registerPath({
  method: 'patch',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/itinerary/absences/{absenceId}/substitute',
  tags: ['Admin · Patients'],
  summary: 'Pôr ou tirar o substituto de uma ausência pontual (Fase 13)',
  description: `${ABSENCE_DESCRIPTION} \`substituteWorkerId: null\` tira o substituto — o dia volta a ser alerta; a chave é obrigatória no corpo.`,
  security: [{ firebaseAuth: [] }],
  request: { params: substituteParams, body: { content: { 'application/json': { schema: substituteBody } } } },
  responses: absenceActionResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/itinerary/absences/{absenceId}/cancel',
  tags: ['Admin · Patients'],
  summary: 'Cancelar uma ausência pontual (Fase 13)',
  description: `${ABSENCE_DESCRIPTION} Cancelar é escrever \`cancelled_at\` — a linha nunca é removida.`,
  security: [{ firebaseAuth: [] }],
  request: { params: substituteParams },
  responses: absenceActionResponses,
});
