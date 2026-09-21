/**
 * ConversationAttachmentPolicy — constantes ÚNICAS de anexo de conversa (spec 022, Bloco 3, D-14).
 *
 * Importada pelo multer (`adminConversationAttachmentRoutes` — limite do upload, 413 antes de
 * qualquer código de aplicação rodar) E pelo `ConversationAttachmentValidator` (defesa em
 * profundidade — o validador não confia em nunca ser chamado fora de um multer configurado) —
 * NUNCA duplicada. `ALLOWED_ATTACHMENT_CONTENT_TYPES` é a MESMA lista do
 * `CHECK (content_type IN (...))` de `stored_files` (migration 459) — mudar uma sem a outra quebra
 * o INSERT ou aceita silenciosamente um tipo que o banco recusaria.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB (D-14)

export const ALLOWED_ATTACHMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export type AllowedAttachmentContentType = (typeof ALLOWED_ATTACHMENT_CONTENT_TYPES)[number];

export function isAllowedAttachmentContentType(value: string): value is AllowedAttachmentContentType {
  return (ALLOWED_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(value);
}
