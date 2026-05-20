import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

const SendVacancyMatchBody = z.object({
  workerId: z.string().uuid().openapi({ description: 'UUID do worker destinatário.', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
  jobPostingId: z.string().uuid().openapi({ description: 'UUID da vaga (atualiza messaged_at e grava log).', example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
});

const SendDirectBody = z.object({
  to: z.string().min(1).openapi({ description: 'Número de telefone em E.164 ou formato local.', example: '+5491112345678' }),
  templateSlug: z.string().min(1).openapi({ description: 'Slug do template de mensagem.', example: 'complete_register_ofc' }),
  variables: z.record(z.string()).optional().openapi({ description: 'Variáveis do template.' }),
});

const CreateTemplateBody = z.object({
  slug: z.string().min(1).openapi({ description: 'Identificador único do template (kebab-case).', example: 'vacancy_match' }),
  name: z.string().min(1).openapi({ description: 'Nome legível do template.', example: 'Match de vaga' }),
  body: z.string().min(1).openapi({ description: 'Corpo da mensagem com variáveis em {{nome}}.', example: 'Olá {{nome}}, encontramos uma vaga para você!' }),
  category: z.string().optional().openapi({ description: 'Categoria do template.', example: 'recrutamento' }),
});

const UpdateTemplateBody = z.object({
  name: z.string().min(1).openapi({ description: 'Novo nome do template.', example: 'Match de vaga v2' }),
  body: z.string().min(1).openapi({ description: 'Novo corpo da mensagem.', example: 'Olá {{nome}}, temos uma vaga especial para você!' }),
  category: z.string().optional().openapi({ description: 'Categoria atualizada.' }),
  isActive: z.boolean().optional().openapi({ description: 'Ativar/desativar template.', example: true }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/messaging/whatsapp/vacancy-match',
  tags: ['Admin · Messaging'],
  summary: 'Envia convite de match de vaga para worker',
  description:
    'Envia WhatsApp de convite de match para um worker. ' +
    'O template é decidido automaticamente pelo status do worker: ' +
    'REGISTERED → ar_vacancy_match_complete; ' +
    'INCOMPLETE_REGISTER → ar_vacancy_match_incomplete; ' +
    'DISABLED (ou outro) → 422 WORKER_STATUS_INVALID.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: SendVacancyMatchBody } } } },
  responses: {
    200: { description: 'Mensagem enviada. Inclui templateSlug usado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'workerId ou jobPostingId ausente.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    422: { description: 'Worker em status inválido ou sem telefone.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: { description: 'Falha no envio via Twilio.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/messaging/whatsapp/direct',
  tags: ['Admin · Messaging'],
  summary: 'Envia WhatsApp direto para número (admin)',
  description:
    'Envia mensagem WhatsApp diretamente para um número de telefone. ' +
    'Registra log de envio com UID do admin que disparou.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: SendDirectBody } } } },
  responses: {
    200: { description: 'Mensagem enviada.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados ausentes.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: { description: 'Falha no envio via Twilio.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/messaging/templates',
  tags: ['Admin · Messaging'],
  summary: 'Lista templates de mensagem',
  description:
    'Retorna templates de WhatsApp. Por padrão retorna apenas ativos. ' +
    'Use `?all=true` para incluir inativos.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      all: z.enum(['true', 'false']).optional().openapi({ description: 'Incluir templates inativos.', example: 'false' }),
    }),
  },
  responses: {
    200: { description: 'Lista de templates.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/messaging/templates',
  tags: ['Admin · Messaging'],
  summary: 'Cria ou atualiza template (upsert por slug)',
  description:
    'Cria novo template ou atualiza existente pelo slug. ' +
    'Retorna 201 se criado, 200 se atualizado.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateTemplateBody } } } },
  responses: {
    201: { description: 'Template criado.', content: { 'application/json': { schema: OkMessage } } },
    200: { description: 'Template atualizado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Campos obrigatórios ausentes.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/messaging/templates/{slug}',
  tags: ['Admin · Messaging'],
  summary: 'Atualiza template de mensagem',
  description:
    'Atualiza name, body e category de um template existente. ' +
    'Não altera o status is_active (use isActive no body para mudar).',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      slug: z.string().openapi({ description: 'Slug do template.', example: 'vacancy_match' }),
    }),
    body: { content: { 'application/json': { schema: UpdateTemplateBody } } },
  },
  responses: {
    200: { description: 'Template atualizado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Campos ausentes.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Template não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/messaging/templates/{slug}',
  tags: ['Admin · Messaging'],
  summary: 'Desativa template de mensagem',
  description:
    'Soft-delete de template: muda is_active para false. ' +
    'O template não aparece mais no GET /templates (sem ?all=true).',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      slug: z.string().openapi({ description: 'Slug do template a desativar.', example: 'vacancy_match' }),
    }),
  },
  responses: {
    200: { description: 'Template desativado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Template não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/messaging/bulk-dispatch-incomplete',
  tags: ['Admin · Messaging'],
  summary: 'Disparo em massa para workers com cadastro incompleto',
  description:
    'Envia WhatsApp (template complete_register_ofc) para workers com encuadre e documentos/perfil incompletos. ' +
    'Suporta `?dryRun=true` para preview sem envio e `?limit=N` para teste pontual.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      dryRun: z.enum(['true', 'false']).optional().openapi({ description: 'Preview sem envio real.', example: 'false' }),
      limit: z.coerce.number().optional().openapi({ description: 'Limita envio aos primeiros N workers.', example: 10 }),
    }),
  },
  responses: {
    200: { description: 'Resultado do disparo em massa.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
