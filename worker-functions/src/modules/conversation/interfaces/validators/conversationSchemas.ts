import { z } from 'zod';

/**
 * Schema para POST /api/admin/patients/:id/conversation/messages
 * Valida o body da criação de mensagem
 */
export const createConversationMessageSchema = z.object({
  body: z.string().min(1).max(4000),
  rootMessageId: z.string().uuid().optional(),
  fileIds: z.array(z.string().uuid()).max(5).optional(),
});

export type CreateConversationMessageBody = z.infer<typeof createConversationMessageSchema>;

/**
 * Schema para PATCH /api/admin/patients/:id/conversation/messages/:mid
 * Valida o body da edição de mensagem
 */
export const updateConversationMessageSchema = z.object({
  body: z.string().min(1).max(4000),
});

export type UpdateConversationMessageBody = z.infer<typeof updateConversationMessageSchema>;

/**
 * Schema para GET /api/admin/patients/:id/conversation
 * Valida os query parameters da listagem de mensagens
 *
 * `after`: cursor no formato "<created_at ISO>,<uuid>" para paginação por cursor
 * `limit`: número máximo de mensagens por página (default 50, máximo 50)
 */
export const conversationMessagesQuerySchema = z.object({
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type ConversationMessagesQuery = z.infer<typeof conversationMessagesQuerySchema>;
