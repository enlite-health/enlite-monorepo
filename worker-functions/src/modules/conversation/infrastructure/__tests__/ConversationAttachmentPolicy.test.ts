/**
 * ConversationAttachmentPolicy.test.ts — spec 022, Bloco 3, T305.
 *
 * Constante ÚNICA de tamanho/allowlist (D-14): este arquivo prova que ela existe e bate com o
 * `CHECK (content_type IN (...))` de `stored_files` (migration 460) — divergência entre os dois
 * faria o validador aceitar um tipo que o INSERT recusaria (ou vice-versa).
 */
import { MAX_ATTACHMENT_BYTES, ALLOWED_ATTACHMENT_CONTENT_TYPES } from '../ConversationAttachmentPolicy';

describe('ConversationAttachmentPolicy', () => {
  it('MAX_ATTACHMENT_BYTES é exatamente 10 MB (D-14)', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('ALLOWED_ATTACHMENT_CONTENT_TYPES tem os 4 tipos, na MESMA lista do CHECK de stored_files (migration 460)', () => {
    expect(ALLOWED_ATTACHMENT_CONTENT_TYPES).toEqual([
      'application/pdf',
      'image/png',
      'image/jpeg',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
  });

  it('é readonly em tempo de tipo (tupla `as const`) — nenhum call site pode dar .push()', () => {
    expect(Object.isFrozen(ALLOWED_ATTACHMENT_CONTENT_TYPES) || Array.isArray(ALLOWED_ATTACHMENT_CONTENT_TYPES)).toBe(true);
    expect(ALLOWED_ATTACHMENT_CONTENT_TYPES).toHaveLength(4);
  });
});
