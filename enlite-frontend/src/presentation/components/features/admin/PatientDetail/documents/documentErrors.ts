/**
 * Erro do servidor → chave i18n (spec 031, FR-003/FR-010). O servidor é quem valida tipo e tamanho
 * (413/415); a tela só traduz. Reaproveita as MESMAS mensagens do anexo do chat
 * (`conversation.errors.*`) — a política de arquivo é uma só (`ConversationAttachmentPolicy`).
 * Nunca ecoa `err.message`: pode carregar o nome do arquivo.
 */
import { ApiError } from '@infrastructure/http/ApiError';

const CHAT_ERRORS = 'admin.patients.detail.conversation.errors';
const DOCS = 'admin.patients.detail.documentsTab';

export function uploadErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_DOCUMENT_LABEL') return `${DOCS}.invalidLabel`;
    if (err.code === 'MALICIOUS_CONTENT_DETECTED') return `${CHAT_ERRORS}.maliciousContent`;
    if (err.code === 'LEGACY_DOC_NOT_ALLOWED') return `${CHAT_ERRORS}.legacyDoc`;
    if (err.status === 413 || err.code === 'FILE_TOO_LARGE') return `${CHAT_ERRORS}.fileTooLarge`;
    if (err.status === 415 || err.code === 'UNSUPPORTED_MEDIA_TYPE') return `${CHAT_ERRORS}.unsupportedType`;
  }
  return `${CHAT_ERRORS}.uploadFailed`;
}

export function renameErrorKey(err: unknown): string {
  return err instanceof ApiError && err.code === 'INVALID_DOCUMENT_LABEL'
    ? `${DOCS}.invalidLabel`
    : `${DOCS}.renameFailed`;
}
