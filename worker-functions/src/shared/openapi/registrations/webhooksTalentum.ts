import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

const TalentumPrescreeningCreatedBody = z.object({
  action: z.literal('PRESCREENING').openapi({ description: 'Tipo de ação do webhook.', example: 'PRESCREENING' }),
  subtype: z.literal('CREATED').openapi({ description: 'Subtipo da ação.', example: 'CREATED' }),
  data: z.object({
    _id: z.string().min(1).openapi({ description: 'ID do prescreening no Talentum.', example: 'psc_abc123' }),
    name: z.string().min(1).openapi({ description: 'Nome do prescreening.', example: 'CASO 766-1' }),
  }).openapi({ description: 'Dados do prescreening criado.' }),
}).openapi({ description: 'Payload de criação de prescreening.' });

const TalentumPrescreeningResponseBody = z.object({
  action: z.literal('PRESCREENING_RESPONSE').openapi({ description: 'Tipo de ação.', example: 'PRESCREENING_RESPONSE' }),
  subtype: z.enum(['INITIATED', 'IN_PROGRESS', 'COMPLETED', 'ANALYZED']).openapi({ description: 'Status do processo do candidato.', example: 'COMPLETED' }),
  data: z.object({
    prescreening: z.object({
      id: z.string().openapi({ example: 'psc_abc123' }),
      name: z.string().openapi({ example: 'CASO 766-1' }),
    }),
    profile: z.object({
      id: z.string().openapi({ example: 'usr_xyz789' }),
      firstName: z.string().openapi({ example: 'João' }),
      lastName: z.string().openapi({ example: 'Silva' }),
      email: z.string().openapi({ example: 'joao.silva@email.com' }),
      phoneNumber: z.string().openapi({ example: '+5491112345678' }),
      cuil: z.string().optional().openapi({ example: '20-12345678-9' }),
    }),
    response: z.object({
      id: z.string().openapi({ example: 'resp_def456' }),
      score: z.number().optional().openapi({ example: 8.5 }),
      statusLabel: z.enum(['QUALIFIED', 'NOT_QUALIFIED', 'PENDING', 'IN_DOUBT']).optional().openapi({ example: 'QUALIFIED' }),
    }),
  }),
}).openapi({ description: 'Payload de resposta de prescreening.' });

const TalentumWebhookPayload = z.union([TalentumPrescreeningCreatedBody, TalentumPrescreeningResponseBody]);

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/talentum/prescreening',
  tags: ['Webhooks · Talentum'],
  summary: 'Recebe eventos de prescreening do Talentum',
  description:
    'Endpoint de webhook para receber notificações do Talentum sobre criação de prescreenings ' +
    'e progressos de candidatos. Autenticado via X-Partner-Key. ' +
    'Dois tipos de evento: PRESCREENING (vaga criada) e PRESCREENING_RESPONSE (candidato progrediu).',
  security: [{ partnerKey: [] }],
  request: {
    body: {
      content: {
        'application/json': { schema: TalentumWebhookPayload },
      },
    },
  },
  responses: {
    200: { description: 'Evento processado com sucesso.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Payload inválido ou action desconhecida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'X-Partner-Key ausente ou inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
