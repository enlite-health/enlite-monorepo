import { registry, z } from '../registry';
import { ErrorResponseSchema, successResponseSchema } from '../schemas/common';

/**
 * Notificações in-app (spec 022, Bloco 4, T407; `contracts/openapi-notifications.md`).
 * Molde: `adminUsers.ts`/`adminStaffDirectory.ts`. Célula `own_notifications:read|update`,
 * família `admin.users` (mesma de `staff-directory` — F11/T007).
 *
 * FR-015 (regra dura): o servidor NUNCA monta a frase final nem inclui corpo de mensagem em
 * nenhum campo — devolve só ids e nomes resolvidos; o CLIENTE monta o texto.
 */
const NotificationItem = z.object({
  id: z.string().uuid(),
  typeCode: z.enum(['CONVERSATION_MENTIONED', 'CONVERSATION_REPLIED']).openapi({ example: 'CONVERSATION_MENTIONED' }),
  actorUid: z.string(),
  actorDisplayName: z.string().nullable(),
  patientId: z.string().uuid().nullable(),
  patientDisplayName: z.string().nullable().openapi({
    description: 'null se o DESTINATÁRIO (quem chama esta rota) não tem `patient_conversation:read` (D-13, revisado no fecho B5).',
  }),
  conversationId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  rootMessageId: z.string().uuid().nullable().openapi({
    description:
      'Item 3 (deep-link, change 022-ux-mencao-e-notificacao): `null` quando a mensagem de origem '
      + 'É o root, preenchido quando é reply. UNGATED — igual ao `messageId`, não depende de '
      + '`patient_conversation:read` (a UI decide "sem acesso" separadamente).',
  }),
  messageExcerpt: z.string().nullable().openapi({
    description:
      'Item 2: até 140 caracteres do corpo, decifrado NA LEITURA. MESMO gate de '
      + '`patientDisplayName` — `null` se o destinatário não tiver `patient_conversation:read` para '
      + 'o paciente da conversa, ou se a decifra falhar. Nunca persistido em `payload`.',
  }),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});

const NotificationListResponse = successResponseSchema(
  'NotificationListResponse',
  z.array(NotificationItem),
  'Notificações do requester, mais recente primeiro.',
);

const UnreadCountResponse = successResponseSchema(
  'UnreadCountResponse',
  z.object({ count: z.number().int() }),
  'Contagem de não lidas — poll do sino a cada 45s (D-10).',
);

const MarkAllReadResponse = successResponseSchema(
  'MarkAllReadResponse',
  z.object({ updated: z.number().int() }),
  'Quantidade de notificações marcadas como lidas nesta chamada.',
);

registry.registerPath({
  method: 'get',
  path: '/api/admin/notifications',
  tags: ['Admin · Notifications'],
  summary: 'Lista notificações do requester',
  description:
    'Lista notificações do `req.user.uid` (nunca de outro uid — isolamento entre destinatários, D-24). ' +
    '`patientDisplayName` só aparece se o ATOR do evento ainda tiver `patient_conversation:read` hoje.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      unread: z.literal('1').optional().openapi({ description: 'Filtra só não lidas.' }),
      limit: z.coerce.number().int().min(1).max(50).optional().openapi({ description: 'Default 20, máximo 50.' }),
    }),
  },
  responses: {
    200: { description: 'Lista de notificações.', content: { 'application/json': { schema: NotificationListResponse } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula `own_notifications:read`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/notifications/unread-count',
  tags: ['Admin · Notifications'],
  summary: 'Contagem de notificações não lidas',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Contagem.', content: { 'application/json': { schema: UnreadCountResponse } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula `own_notifications:read`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/notifications/{id}/read',
  tags: ['Admin · Notifications'],
  summary: 'Marca UMA notificação como lida',
  description:
    'Só marca notificação do PRÓPRIO requester. Notificação alheia ou inexistente devolve 404 ' +
    '(nunca 403 — não confirma existência a quem não é dono, decisão do orquestrador da spec 022).',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Marcada como lida.', content: { 'application/json': { schema: successResponseSchema('MarkReadResponse', z.object({})) } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula `own_notifications:update`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Notificação alheia ou inexistente.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/notifications/read-all',
  tags: ['Admin · Notifications'],
  summary: 'Marca todas as notificações do requester como lidas',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Quantidade marcada.', content: { 'application/json': { schema: MarkAllReadResponse } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula `own_notifications:update`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
