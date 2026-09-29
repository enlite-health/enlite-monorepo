import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

/**
 * Registro OpenAPI do modal do prestador (quadro C, rodada 2, decisão D). Arquivo PRÓPRIO —
 * mesmo motivo do `adminServiceTeam.ts` (limite de linhas) e da separação do router.
 */
const serviceTeamContactParams = z.object({ id: z.string().uuid(), sid: z.string().uuid(), workerId: z.string().uuid() });
const serviceTeamContactBody = z.object({
  contacted: z.boolean(),
  eventDate: z.string(),
  note: z.string().nullable().optional(),
});

const serviceTeamContactResponses = {
  200: { description: 'Nome/telefone projetados (célula worker_contact:read) + histórico de contato.', content: { 'application/json': { schema: OkMessage } } },
  400: { description: 'params/body inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  403: { description: 'Sem a célula exigida pela rota.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  404: { description: 'Serviço inexistente/de outro paciente/fora da RLS, ou prestador que não é (nem foi) deste time.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
} as const;

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/team/{workerId}/contact',
  tags: ['Admin · Patients'],
  summary: 'Modal do prestador: nome/telefone (projetado) + histórico de contato do par serviço×prestador',
  description:
    'Telefone só sai com `worker_contact:read` (a mesma célula que já protege o nome no quadro C) — ' +
    'sem ela, `phone` vem `null`, nunca erro. O histórico é o log de contato (migration 488), ' +
    'append-only: uma linha por "Guardar" do modal.',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceTeamContactParams },
  responses: serviceTeamContactResponses,
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/contracted-services/{sid}/team/{workerId}/contact',
  tags: ['Admin · Patients'],
  summary: 'Registra um contato com o prestador (linha nova no histórico, nunca update)',
  description:
    '`contacted` (Sí/No), `eventDate` (YYYY-MM-DD) e `note` (texto livre — nunca sai em log). ' +
    'O prestador precisa estar em `selected`/`inService`/`rejected` do time ATUAL do serviço — ' +
    'senão 404 (mesma régua de não vazar existência do GET .../team).',
  security: [{ firebaseAuth: [] }],
  request: { params: serviceTeamContactParams, body: { content: { 'application/json': { schema: serviceTeamContactBody } } } },
  responses: serviceTeamContactResponses,
});
