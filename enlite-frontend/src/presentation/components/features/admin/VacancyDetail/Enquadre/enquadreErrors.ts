/**
 * Erro do servidor → chave i18n da aba Enquadre (spec 052). O servidor devolve `code` estável; a tela traduz.
 * Nunca ecoa `err.message` (pode carregar nome de prestador). Molde: `admissionErrors.ts`.
 * `MOVE_REASON_REQUIRED`/`MOVE_REASON_INVALID` NÃO passam por aqui: o kanban do evento os trata (diálogo de motivo).
 */
import { ApiError } from '@infrastructure/http/ApiError';

const E = 'admin.vacancyDetail.enquadre';

const CODES: Record<string, string> = {
  TACTIQ_LINK_REQUIRED: `${E}.errors.tactiqLinkRequired`,
  HOST_NOT_IN_ROSTER: `${E}.errors.hostNotInRoster`,
  ENQUADRE_WORKER_NOT_AVAILABLE: `${E}.errors.workerNotAvailable`,
  ENQUADRE_WORKER_EMAIL_INVALID: `${E}.errors.workerEmailInvalid`,
  ENQUADRE_GUEST_NOT_ALLOWED: `${E}.errors.guestNotAllowed`,
  ENQUADRE_CONFIG_INVALID: `${E}.errors.configInvalid`,
  ENQUADRE_SLOT_IN_PAST: `${E}.errors.slotInPast`,
  // O texto aprovado do estado E7 ("No se guardó nada"): é o mesmo que o drawer já mostrava.
  CALENDAR_CREATE_FAILED: `${E}.create.googleError`,
  CALENDAR_UPDATE_FAILED: `${E}.errors.calendarUpdateFailed`,
  ENQUADRE_EVENT_NOT_OPEN: `${E}.errors.eventNotOpen`,
  ENQUADRE_EVENT_NOT_ENDED: `${E}.errors.eventNotEnded`,
  ENQUADRE_PARTICIPANT_ALREADY_MARKED: `${E}.errors.participantAlreadyMarked`,
  ENQUADRE_EVENT_NOT_FOUND: `${E}.errors.eventNotFound`,
};

/** Códigos de 409 que dizem "o estado mudou": a tela recarrega os dados depois de mostrar o motivo. */
const STATE_CONFLICT = new Set([
  'ENQUADRE_EVENT_NOT_OPEN',
  'ENQUADRE_EVENT_NOT_ENDED',
  'ENQUADRE_WORKER_NOT_AVAILABLE',
  'ENQUADRE_PARTICIPANT_ALREADY_MARKED',
]);

/** Chave (completa) da mensagem; `fallbackKey` (completa) quando o código é desconhecido ou o erro não veio do servidor. */
export function enquadreErrorKey(err: unknown, fallbackKey: string = `${E}.errors.generic`): string {
  return (err instanceof ApiError && err.code && CODES[err.code]) || fallbackKey;
}

export function isEnquadreStateConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && Boolean(err.code && STATE_CONFLICT.has(err.code));
}

export const ENQUADRE_ERROR_KEYS: readonly string[] = Object.values(CODES);
