import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

/**
 * Registro OpenAPI da leitura do itinerário (fase 7, DX-7.8). Arquivo PRÓPRIO — `adminPatients.ts`
 * já tem 436 linhas (> 400, regra do CLAUDE.md do monorepo).
 */
registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/itinerary',
  tags: ['Admin · Patients'],
  summary: 'Itinerário e horas cobertas por serviço contratado',
  description:
    'Horas cobertas por serviço contratado, do itinerário semanal (`patient_itinerary_slot` + ' +
    '`patient_itinerary_assignment`). `cobertas` em horas/semana; `contratadas.authorized` não ' +
    'declara período (é copiado, nunca calculado). Sem backfill: serviço cujo horário não foi ' +
    'salvo depois da migration 480 aparece com `slots: []`. `alerts: [{ serviceId, date, ' +
    'startTime, endTime }]` (fase 13): ausência sem substituto, data ≥ hoje (Buenos Aires); sem nome. ' +
    '`assembledAt` (ISO UTC, `null` = nunca montado): `max(assembled_at)` de `patient_itinerary_assembly`. ' +
    'Fase 12: cada alocação traz `allocationId` e `displayName` (só vigente; `null` sem `worker_contact:read`).',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Itinerário do paciente.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'params inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula patient_services:read.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Paciente não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
