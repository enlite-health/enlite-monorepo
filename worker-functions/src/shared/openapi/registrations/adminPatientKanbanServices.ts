import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

/**
 * Registro OpenAPI do agregado do subcard do Kanban de pacientes (fase 8, Plano B, DX-8.1).
 * Arquivo PRÓPRIO (mesma razão do itinerário: `adminPatients.ts` já tem 436 linhas > 400 —
 * regra do CLAUDE.md do monorepo).
 */
registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/kanban/services',
  tags: ['Admin · Patients'],
  summary: 'Agregado do subcard do Kanban: uma linha por serviço ativo por paciente',
  description:
    'Uma linha por serviço ATIVO por paciente para o subcard do Kanban de pacientes (fase 8, ' +
    'Plano B). `cobertas` vem do itinerário, em horas/semana; `contratadas.authorized` não ' +
    'declara período — copiado, nunca calculado (P1). Só pacientes com >= 1 serviço ativo. Uma ' +
    'chamada por carga do board inteiro, nunca uma por card (sem N+1).',
  security: [{ firebaseAuth: [] }],
  request: { query: z.object({ country: z.enum(['AR', 'BR']).optional() }) },
  responses: {
    200: { description: 'Agregado do Kanban.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'query inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula patient_services:read.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
