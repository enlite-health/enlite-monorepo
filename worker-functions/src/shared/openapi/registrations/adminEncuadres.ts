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
  targetStage: z
    .enum([
      'INVITED', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'QUALIFIED',
      'IN_DOUBT', 'CONFIRMED', 'SELECTED', 'REJECTED',
    ])
    .openapi({
      description: 'Etapa de destino no funil (coluna do Kanban).',
      example: 'CONFIRMED',
    }),
  role: z.enum(['TITULAR', 'RAPID_RESPONSE']).optional().openapi({
    description: 'Papel do prestador. Só aceito ao mover para SELECTED.',
    example: 'TITULAR',
  }),
  rejectionReasonCategory: z.string().optional().openapi({
    description: 'Categoria do motivo. Usado ao mover para REJECTED.',
  }),
  rejectionReason: z.string().optional().openapi({
    description: 'Motivo livre da rejeição.',
  }),
  interviewDate: z.string().optional().openapi({
    description:
      'Data da entrevista (YYYY-MM-DD), no fuso da operação (Buenos Aires). ' +
      'Opcional — mover sem data é válido ("ainda não sei"). Exige interviewTime junto.',
    example: '2026-08-05',
  }),
  interviewTime: z.string().optional().openapi({
    description:
      'Hora da entrevista (HH:MM, 24h), no fuso da operação. Exige interviewDate junto. ' +
      'Convertida para timestamptz pelo servidor — o fuso do navegador nunca é usado.',
    example: '14:30',
  }),
  interviewMeetLink: z.string().url().optional().openapi({
    description: 'Link da videochamada da entrevista.',
    example: 'https://meet.google.com/abc-defg-hij',
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
  summary: 'Move o card do encuadre no funil (Kanban)',
  description:
    'Move a candidatura para outra etapa do funil, gravando `application_funnel_stage` e ' +
    'sincronizando `encuadres.resultado` nos estados terminais (SELECTED/REJECTED). ' +
    'Ao mover para CONFIRMED, aceita data e hora da entrevista — é o único ponto em que o ' +
    'sistema registra QUANDO a entrevista acontece, o que alimenta lembretes e marcação de falta. ' +
    'A descrição anterior ("transfere um encuadre de uma vaga para outra", body `jobPostingId`) ' +
    'nunca correspondeu ao comportamento real desta rota.',
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
