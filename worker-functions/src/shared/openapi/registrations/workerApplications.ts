import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';

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

// Spec 067 FR-16/17: o link do pré-screening da Talentum chega ao front SÓ neste 200 (postulação aprovada). A 403 não o carrega.
const TrackChannelOk = z
  .object({
    success: z.literal(true),
    data: z.object({
      prescreeningUrl: z.string().nullable().openapi({
        description: 'Link do pré-screening da Talentum da vaga (nulo quando a vaga não tem). Só existe na resposta aprovada.',
        example: 'https://talentum.example.test/public/pre-screening/00000000-0000-4000-8000-000000000000/chat',
      }),
    }),
  })
  .openapi({ description: 'Postulação aprovada.' });

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
    200: { description: 'Canal registrado com sucesso e postulação aprovada. Traz data.prescreeningUrl.', content: { 'application/json': { schema: TrackChannelOk } } },
    403: { description: 'Prestador não elegível (WORKER_NOT_ELIGIBLE). NÃO traz o link da Talentum.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
