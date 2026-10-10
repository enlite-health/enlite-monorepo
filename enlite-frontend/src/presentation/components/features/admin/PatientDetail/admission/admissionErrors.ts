/**
 * Erro do servidor → chave i18n da aba Admissão (spec 049, F7). O servidor devolve `code` estável; a tela traduz.
 * Nunca ecoa `err.message` (pode carregar e-mail do responsável).
 */
import { ApiError } from '@infrastructure/http/ApiError';

const A = 'admin.patients.detail.admissionTab';

const BOOK_CODES: Record<string, string> = {
  SLOT_TAKEN: `${A}.errors.slotTaken`,
  TACTIQ_LINK_REQUIRED: `${A}.errors.tactiqLinkRequired`,
  SLOT_IN_PAST: `${A}.errors.slotInPast`,
  HOST_NOT_IN_ROSTER: `${A}.errors.hostNotInRoster`,
  INVALID_SLOT: `${A}.errors.invalidSlot`,
};

const RESEND_CODES: Record<string, string> = {
  RESEND_NOT_ALLOWED: `${A}.errors.resendNotAllowed`,
  RESEND_LIMIT_REACHED: `${A}.errors.resendLimitReached`,
  RESEND_IN_PROGRESS: `${A}.errors.resendInProgress`,
};

export function bookErrorKey(err: unknown): string {
  return (err instanceof ApiError && err.code && BOOK_CODES[err.code]) || `${A}.errors.bookFailed`;
}

export function resendErrorKey(err: unknown): string {
  return (err instanceof ApiError && err.code && RESEND_CODES[err.code]) || `${A}.errors.resendFailed`;
}

export function cancelErrorKey(err: unknown): string {
  return err instanceof ApiError && err.code === 'APPOINTMENT_NOT_CANCELLABLE'
    ? `${A}.errors.cancelNotAllowed`
    : `${A}.errors.cancelFailed`;
}

/** O 409 de regra (não de falha de rede) significa "o estado mudou": a tela recarrega a lista. */
export function isStateConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}
