import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const CreateSlotsBody = z.object({
  coordinatorId: z.string().uuid().optional().openapi({ description: 'UUID do coordenador responsável pelos slots.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
  meetLink: z.string().url().optional().openapi({ description: 'Link Google Meet padrão para os slots.', example: 'https://meet.google.com/abc-defg-hij' }),
  notes: z.string().optional().openapi({ description: 'Observações sobre os slots de entrevista.', example: 'Entrevistas da semana 20-24/05' }),
  slots: z.array(
    z.object({
      startTime: z.string().datetime().openapi({ description: 'Início do slot em ISO 8601.', example: '2026-05-20T10:00:00Z' }),
      endTime: z.string().datetime().openapi({ description: 'Fim do slot em ISO 8601.', example: '2026-05-20T10:30:00Z' }),
      capacity: z.number().int().positive().optional().openapi({ description: 'Capacidade máxima de candidatos (default 1).', example: 1 }),
    })
  ).min(1).openapi({ description: 'Array de slots de entrevista a criar.' }),
});

const BookSlotBody = z.object({
  encuadreId: z.string().uuid().openapi({ description: 'UUID do encuadre a vincular ao slot.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
  sendInvitation: z.boolean().optional().openapi({ description: 'Se deve enviar convite de calendário (default true).', example: true }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/{id}/interview-slots',
  tags: ['Admin · Interview Slots'],
  summary: 'Cria slots de entrevista para uma vaga',
  description:
    'Cria um ou mais slots de entrevista para a vaga. ' +
    'Cada slot pode ter capacidade para múltiplos candidatos (default 1).',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: CreateSlotsBody } } },
  },
  responses: {
    201: { description: 'Slots criados.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos (ex: slots vazio).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/{id}/interview-slots',
  tags: ['Admin · Interview Slots'],
  summary: 'Lista slots de entrevista de uma vaga',
  description:
    'Retorna todos os slots da vaga com status (AVAILABLE, FULL, CANCELLED) e resumo agregado. ' +
    'Filtro por `?status=AVAILABLE` retorna apenas slots disponíveis.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    query: z.object({
      status: z.enum(['AVAILABLE', 'FULL', 'CANCELLED']).optional().openapi({ description: 'Filtro por status do slot.' }),
    }),
  },
  responses: {
    200: { description: 'Slots de entrevista.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/interview-slots/{slotId}/book',
  tags: ['Admin · Interview Slots'],
  summary: 'Reserva slot de entrevista para encuadre',
  description:
    'Vincula um encuadre a um slot de entrevista disponível. ' +
    'Opcionalmente envia convite de Google Calendar ao worker.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ slotId: UuidParam }),
    body: { content: { 'application/json': { schema: BookSlotBody } } },
  },
  responses: {
    200: { description: 'Slot reservado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'encuadreId ausente ou slot cheio.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Slot não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/interview-slots/{slotId}',
  tags: ['Admin · Interview Slots'],
  summary: 'Cancela slot de entrevista',
  description:
    'Muda o status do slot para CANCELLED. ' +
    'Encuadres vinculados ao slot devem ser movidos manualmente.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ slotId: UuidParam }) },
  responses: {
    200: { description: 'Slot cancelado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Slot não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
