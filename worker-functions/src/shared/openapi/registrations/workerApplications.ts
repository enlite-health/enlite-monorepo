import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

const TrackChannelBody = z.object({
  jobPostingId: z.string().min(1).openapi({
    description: 'UUID da vaga (job_posting) para registrar o canal de aquisição.',
    example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91',
  }),
  channel: z.enum(['facebook', 'instagram', 'whatsapp', 'linkedin', 'site']).openapi({
    description: 'Canal de aquisição social. First-touch wins — não sobrescreve canal já registrado.',
    example: 'instagram',
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/worker-applications/track-channel',
  tags: ['Worker · Applications'],
  summary: 'Registra canal de aquisição da candidatura',
  description:
    'Rastreia o canal social pelo qual o worker chegou à vaga (first-touch wins). ' +
    'Faz upsert de WJA em status INITIATED e garante encuadre na coluna Kanban. ' +
    'Não sobrescreve canal já registrado.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: TrackChannelBody } } } },
  responses: {
    200: { description: 'Canal registrado com sucesso.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
