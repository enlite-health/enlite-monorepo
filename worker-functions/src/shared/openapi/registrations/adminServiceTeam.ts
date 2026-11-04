import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

/**
 * Registro OpenAPI do quadro C (Servicio Contratado) — Fase 10, DX-10.7. Arquivo PRÓPRIO (mesma
 * razão do itinerário e do agregado do Kanban: `adminPatients.ts` já tem 436 linhas > 400 — regra
 * do CLAUDE.md do monorepo).
 */
const serviceTeamParams = z.object({ id: z.string().uuid(), sid: z.string().uuid() });
const serviceTeamMarkBody = z.object({ workerId: z.string().uuid(), reasonCategory: z.string().optional() });

const serviceTeamResponses = {
  200: { description: 'Time do serviço, recalculado.', content: { 'application/json': { schema: OkMessage } } },
  400: { description: 'params/body inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  403: { description: 'Sem a célula exigida pela rota.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  404: { description: 'Serviço inexistente, de outro paciente, ou fora da RLS.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  409: { description: 'Corrida: já há uma rejeição ativa para o par.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  422: { description: 'Motivo ausente/inválido, ou o prestador não pode receber a marca.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
} as const;

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/team',
  tags: ['Admin · Patients'],
  summary: 'Time do quadro C (Servicio Contratado): calculado; a única coisa gravada é a marca de rejeição; nunca adiciona prestador',
  description:
    'Calculado a partir da vaga viva do serviço, do itinerário, das marcas de rejeição e das ausências com ' +
    'substituto (Fase 13) — nunca grava. `selected`/`inService`/`rejected`, um mesmo prestador nunca em duas ' +
    'listas. A resposta traz `asOf` (a data LOCAL do país do paciente usada para decidir vigência); em ' +
    '`inService`, o titular vem com `allocations` (id/dia/horário da alocação) e quem substitui vem com ' +
    '`substitutionDates` (as datas vigentes, ordem crescente).',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceTeamParams },
  responses: serviceTeamResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/team/reject',
  tags: ['Admin · Patients'],
  summary: 'Rejeitar um prestador do quadro C, com motivo de lista fechada',
  description:
    'Calculado; a única coisa gravada é a marca de rejeição; nunca adiciona prestador. Rejeitar ' +
    'quem está Em Atendimento é 422 (remova do itinerário primeiro); rejeitar quem não é ' +
    'candidato da vaga viva é 422; motivo ausente/fora da lista fechada é 422, antes do banco.',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceTeamParams, body: { content: { 'application/json': { schema: serviceTeamMarkBody } } } },
  responses: serviceTeamResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/team/revert',
  tags: ['Admin · Patients'],
  summary: 'Reverter uma marca de rejeição do quadro C, com motivo de lista fechada',
  description:
    'Calculado; a única coisa gravada é a marca revertida (`reverted_at`/`reverted_by`) — nunca ' +
    'DELETE. Reverter quem não está rejeitado é 422; motivo ausente/fora da lista fechada é 422, ' +
    'antes do banco.',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceTeamParams, body: { content: { 'application/json': { schema: serviceTeamMarkBody } } } },
  responses: serviceTeamResponses,
});
