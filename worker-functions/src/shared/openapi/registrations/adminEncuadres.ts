import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const EncuadreResultBody = z.object({
  resultado: z.enum(['PENDIENTE', 'SELECCIONADO', 'RECHAZADO', 'AT_NO_ACEPTA', 'REPROGRAMAR']).openapi({
    description: 'Resultado do encuadre (entrevista de matching).',
    example: 'SELECCIONADO',
  }),
  rejectionReason: z.string().optional().openapi({ description: 'Motivo de rejeição (quando RECHAZADO).', example: 'Indisponibilidade de horário' }),
  rejectionReasonCategory: z.string().optional().openapi({ description: 'Categoria do motivo de rejeição.', example: 'HORARIO' }),
  attended: z.boolean().optional().openapi({ description: 'Se o worker compareceu à entrevista.', example: true }),
  acceptsCase: z.boolean().optional().openapi({ description: 'Se o worker aceitou o caso.', example: true }),
});

const EncuadreMoveBody = z.object({
  jobPostingId: z.string().uuid().openapi({
    description: 'UUID da vaga de destino para transferir o encuadre.',
    example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91',
  }),
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/encuadres/{id}/result',
  tags: ['Admin · Encuadres'],
  summary: 'Registra resultado de encuadre',
  description:
    'Atualiza o resultado de um encuadre (entrevista de matching) após a realização. ' +
    'Valores possíveis: PENDIENTE, SELECCIONADO, RECHAZADO, AT_NO_ACEPTA, REPROGRAMAR.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: EncuadreResultBody } } },
  },
  responses: {
    200: { description: 'Resultado registrado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Resultado inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Encuadre não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/encuadres/{id}/move',
  tags: ['Admin · Encuadres'],
  summary: 'Move encuadre para outra vaga',
  description:
    'Transfere um encuadre de uma vaga para outra. ' +
    'Usado quando o worker é redirecionado para um caso diferente.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: EncuadreMoveBody } } },
  },
  responses: {
    200: { description: 'Encuadre movido.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Encuadre não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
