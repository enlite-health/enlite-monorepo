import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, successResponseSchema, UuidParam } from '../schemas/common';

/**
 * `src/modules/conversation/interfaces/routes/adminConversationRoutes.ts` (spec 022, T123/T313).
 * Molde: `adminUsers.ts`. Documenta as 8 rotas do contrato — as 2 de anexo (`.../files`,
 * `.../files/:fileId/url`, Bloco 3, T311/T312/T314/T315) entraram nesta task.
 *
 * Célula sempre `patient_conversation:read|create|update|delete`, família `admin.patients`.
 */
const PatientIdParams = z.object({ id: UuidParam });
const MessageIdParams = z.object({ id: UuidParam, mid: UuidParam });
const FileIdParams = z.object({ id: UuidParam, fileId: UuidParam });

const AttachmentDto = z.object({
  fileId: z.string().uuid(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

const ConversationMessageDto = z.object({
  id: z.string().uuid(),
  authorUid: z.string().openapi({ description: 'Firebase UID de quem escreveu.' }),
  authorDisplayName: z.string().nullable().openapi({
    description:
      'Nome de exibição do autor, resolvido por JOIN no SERVIDOR (item 5a da change '
      + '022-ux-mencao-e-notificacao) — nunca depende do `staffNameCache` do navegador. `null` só '
      + 'se o autor não tiver registro em `users` (defesa, não esperado no caminho normal).',
  }),
  body: z.string().openapi({
    description:
      'Corpo decifrado. String VAZIA (nunca `null`) quando a mensagem foi apagada (soft delete) — '
      + 'achado do gate revisao-pr (Bloco 1): `KMSEncryptionService.decrypt` devolve `\'\'` para '
      + 'ciphertext nulo, o código nunca entrega `null` aqui.',
  }),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  mentions: z.array(z.string()).openapi({ description: 'UIDs mencionados (`<@uid>` no corpo), ordem alfabética.' }),
  mentionDisplayNames: z.record(z.string(), z.string().nullable()).openapi({
    description:
      'Nome de exibição de cada uid de `mentions` (item 5a), resolvido na MESMA leitura — chave é '
      + 'o uid, valor `null` se aquele uid não tiver `display_name` resolvível.',
  }),
  replyCount: z.number().int().nonnegative().openapi({ description: 'Sempre 0 numa reply — thread de 1 nível (D-03).' }),
  lastReplyAt: z.string().datetime().nullable(),
  attachments: z.array(AttachmentDto).openapi({
    description: 'Sempre `[]` hoje — leitura de anexo é Bloco 3, ainda não implementada.',
  }),
});

const CreateMessageBody = z.object({
  body: z.string().min(1).max(4000),
  rootMessageId: z.string().uuid().optional().openapi({
    description: 'Se presente, normaliza para o ROOT do root — responder a uma reply nunca gera thread de 2 níveis (D-03).',
  }),
  fileIds: z.array(z.string().uuid()).max(5).optional(),
});

const UpdateMessageBody = z.object({ body: z.string().min(1).max(4000) });

const ConversationListQuery = z.object({
  after: z.string().optional().openapi({
    description: 'Cursor `"<created_at ISO>,<uuid>"` para paginação.',
    example: '2026-09-20T12:00:00.000Z,6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91',
  }),
  limit: z.coerce.number().int().min(1).max(50).optional().openapi({ description: 'Default 50, teto 50.' }),
});

const ConversationListResponse = successResponseSchema(
  'ConversationListResponse',
  z.object({
    conversationId: z.string().uuid(),
    messages: z.array(ConversationMessageDto),
    nextCursor: z.string().nullable(),
    lastReadAt: z.string().datetime().nullable().openapi({
      description:
        'Marca de leitura do ATOR atual (`conversation_read_marks.last_read_at`). `null` quando o '
        + 'ator nunca chamou `PUT .../read-mark` nesta conversa (Bloco 2, D-11).',
    }),
    unreadCount: z.number().int().nonnegative().openapi({
      description:
        'Mensagens (TOPO e REPLY) com `created_at > lastReadAt` e `authorUid` diferente do ator '
        + '(D-11). Sem `lastReadAt`, conta tudo que não é do próprio ator. Calculado em UMA query, '
        + 'nunca por mensagem.',
    }),
  }),
);

const ConversationRepliesResponse = successResponseSchema(
  'ConversationRepliesResponse',
  z.object({ messages: z.array(ConversationMessageDto) }),
  'Replies de UMA mensagem de topo, ordenadas por `created_at ASC`. `:mid` que é uma reply — 400.',
);

const PostMessageResponse = successResponseSchema(
  'PostMessageResponse',
  z.object({ id: z.string().uuid(), createdAt: z.string().datetime() }),
);

const patientNotFound = { description: 'Paciente inexistente.', content: { 'application/json': { schema: ErrorResponseSchema } } };
const noSession = { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } };
const noCell = { description: 'Sem a célula exigida.', content: { 'application/json': { schema: ErrorResponseSchema } } };
const serverError = { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } };

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/conversation',
  tags: ['Admin · Conversation'],
  summary: 'Lista a conversa do paciente',
  description:
    'Célula `patient_conversation:read`. Paginação por cursor (`after`/`nextCursor`). Resposta traz '
    + '`lastReadAt`/`unreadCount` do ATOR atual (Bloco 2, D-11) — a base do badge do handle.',
  security: [{ firebaseAuth: [] }],
  request: { params: PatientIdParams, query: ConversationListQuery },
  responses: {
    200: { description: 'Página de mensagens de TOPO (não-reply).', content: { 'application/json': { schema: ConversationListResponse } } },
    400: { description: 'Params/query inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: noSession,
    403: noCell,
    404: patientNotFound,
    500: serverError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/conversation/messages/{mid}/replies',
  tags: ['Admin · Conversation'],
  summary: 'Lista as replies de uma mensagem de topo',
  description:
    'Célula `patient_conversation:read` — MESMA célula da listagem (o contrato não pede uma própria para ' +
    'replies). `:mid` tem de ser mensagem de TOPO (`root_message_id IS NULL`); se `:mid` já é uma reply, ' +
    '400 `ROOT_MESSAGE_IS_REPLY` (thread de 1 nível, D-03). `:mid` inexistente devolve 200 com `messages: []` ' +
    '(decisão de implementação — o contrato não define esse caso; ver `evidencias/b1-replies-mentions.md`).',
  security: [{ firebaseAuth: [] }],
  request: { params: MessageIdParams },
  responses: {
    200: { description: 'Replies ordenadas por `created_at ASC`.', content: { 'application/json': { schema: ConversationRepliesResponse } } },
    400: {
      description: '`:mid` é uma reply, não uma mensagem de topo (`code: ROOT_MESSAGE_IS_REPLY`).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: noSession,
    403: noCell,
    404: patientNotFound,
    500: serverError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/conversation/messages',
  tags: ['Admin · Conversation'],
  summary: 'Posta mensagem (ou reply) na conversa do paciente',
  description:
    'Célula `patient_conversation:create`. Extrai `<@uid>` do `body` e valida cada um contra `users` — 400 ' +
    '`MENTIONED_USER_NOT_FOUND` se algum não existir. `rootMessageId` normaliza para o ROOT DO ROOT (D-03): ' +
    'responder a uma reply nunca cria thread de 2 níveis.',
  security: [{ firebaseAuth: [] }],
  request: { params: PatientIdParams, body: { content: { 'application/json': { schema: CreateMessageBody } } } },
  responses: {
    201: { description: 'Mensagem criada.', content: { 'application/json': { schema: PostMessageResponse } } },
    400: {
      description: 'Body inválido ou menção a uid inexistente (`code: MENTIONED_USER_NOT_FOUND`).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: noSession,
    403: noCell,
    404: patientNotFound,
    500: serverError,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/admin/patients/{id}/conversation/messages/{mid}',
  tags: ['Admin · Conversation'],
  summary: 'Edita a própria mensagem',
  description:
    'Célula `patient_conversation:update`. Só o AUTOR pode editar (D-04) — 403 `NOT_MESSAGE_AUTHOR` mesmo ' +
    'com a célula, se não for o autor. `:mid` inexistente — 404 `MESSAGE_NOT_FOUND`.',
  security: [{ firebaseAuth: [] }],
  request: { params: MessageIdParams, body: { content: { 'application/json': { schema: UpdateMessageBody } } } },
  responses: {
    200: { description: 'Editada.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Body inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: noSession,
    403: { description: 'Sem a célula, OU tem a célula mas não é o autor (`code: NOT_MESSAGE_AUTHOR`).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Mensagem inexistente (`code: MESSAGE_NOT_FOUND`).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: serverError,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/patients/{id}/conversation/messages/{mid}',
  tags: ['Admin · Conversation'],
  summary: 'Apaga a própria mensagem (soft delete)',
  description:
    'Célula `patient_conversation:delete`. Só o AUTOR (D-04) — 403 `NOT_MESSAGE_AUTHOR`. Soft delete: ' +
    '`deleted_at = now()`, corpo cifrado apagado (`body_encrypted = NULL`); replies existentes permanecem.',
  security: [{ firebaseAuth: [] }],
  request: { params: MessageIdParams },
  responses: {
    200: { description: 'Apagada.', content: { 'application/json': { schema: OkMessage } } },
    401: noSession,
    403: { description: 'Sem a célula, OU tem a célula mas não é o autor (`code: NOT_MESSAGE_AUTHOR`).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Mensagem inexistente (`code: MESSAGE_NOT_FOUND`).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: serverError,
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/patients/{id}/conversation/read-mark',
  tags: ['Admin · Conversation'],
  summary: 'Marca a conversa como lida pelo ator atual',
  description: 'Célula `patient_conversation:read`. Upsert em `conversation_read_marks` (`last_read_at = now()`).',
  security: [{ firebaseAuth: [] }],
  request: { params: PatientIdParams },
  responses: {
    200: { description: 'Marcada.', content: { 'application/json': { schema: OkMessage } } },
    401: noSession,
    403: noCell,
    404: patientNotFound,
    500: serverError,
  },
});

// ── Anexo (spec 022, Bloco 3, T311/T312/T314/T315; D-14) ───────────────────────────────────────

const UploadAttachmentBody = z.object({
  file: z.string().openapi({ format: 'binary', description: 'PDF, PNG, JPEG ou .docx — máx. 10 MB (MAX_ATTACHMENT_BYTES).' }),
});

const UploadAttachmentResponse = successResponseSchema('UploadAttachmentResponse', z.object({ fileId: z.string().uuid() }));

const AttachmentUrlResponse = successResponseSchema(
  'AttachmentUrlResponse',
  z.object({
    url: z.string().url(),
    expiresInSeconds: z.number().int().openapi({ description: 'Sempre 300 (READ_URL_TTL_SECONDS).' }),
  }),
);

const attachmentRejected415 = {
  description:
    'Rejeitado pelo pipeline de validação (D-14): `UNSUPPORTED_MEDIA_TYPE` (magic byte fora da allowlist), '
    + '`MALICIOUS_CONTENT_DETECTED` (PDF com `/JavaScript`/ação, ou `.docx` com macro/`vbaProject.bin`), ou '
    + '`LEGACY_DOC_NOT_ALLOWED` (`.doc` legado — mensagem ES+PT pedindo `.docx`).',
  content: { 'application/json': { schema: ErrorResponseSchema } },
};

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/conversation/files',
  tags: ['Admin · Conversation'],
  summary: 'Sobe um anexo (upload separado do POST de mensagem)',
  description:
    'Célula `patient_conversation:create`. Pipeline D-14, nesta ordem: magic bytes (`file-type`) → allowlist → '
    + 'imagem: `sharp` re-encode (strip EXIF) → PDF: recusa `/JavaScript`/`/JS`/`/OpenAction`/`/Launch`/'
    + '`/EmbeddedFile` → `.docx`: abre zip (`yauzl`), recusa `word/vbaProject.bin`/`macroEnabled` → `.doc`: '
    + 'recusa direta. `fileId` devolvido aqui entra no `fileIds` do `POST .../conversation/messages` para '
    + 'virar anexo de uma mensagem — upload sozinho NÃO aparece em `conversation`/`replies` até ser anexado.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: PatientIdParams,
    body: { content: { 'multipart/form-data': { schema: UploadAttachmentBody } } },
  },
  responses: {
    201: { description: 'Arquivo armazenado.', content: { 'application/json': { schema: UploadAttachmentResponse } } },
    401: noSession,
    403: noCell,
    404: patientNotFound,
    413: { description: '`FILE_TOO_LARGE` — acima de 10 MB.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    415: attachmentRejected415,
    500: serverError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/conversation/files/{fileId}/url',
  tags: ['Admin · Conversation'],
  summary: 'URL assinada de download do anexo',
  description:
    'Célula `patient_conversation:read`. Signed URL v4, 300 s, `responseDisposition: attachment` com o nome '
    + 'ORIGINAL decifrado. Posse: `fileId` precisa estar ANEXADO a uma mensagem da conversa do paciente `:id` '
    + '(join `stored_files` → `conversation_message_attachments` → `conversation_messages` → `conversations`) '
    + '— arquivo de outro paciente, ou ainda não anexado a mensagem nenhuma, devolve 404 (nunca vaza qual das '
    + 'duas causas). `logResourceAccess` grava a trilha de leitura, só em acesso bem-sucedido.',
  security: [{ firebaseAuth: [] }],
  request: { params: FileIdParams },
  responses: {
    200: { description: 'URL assinada.', content: { 'application/json': { schema: AttachmentUrlResponse } } },
    401: noSession,
    403: noCell,
    404: { description: 'Paciente inexistente, OU arquivo inexistente/não pertence a este paciente.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: serverError,
  },
});
