/**
 * interviewFlowTemplateSlugs — slugs de message_templates que pertencem ao
 * fluxo de entrevista (convite → slot → reminder → confirm/reschedule).
 *
 * Extraído de InboundWhatsAppController (canal Twilio) para ser
 * compartilhado com PeriskopeInboundRouter (canal Periskope, item 2.3) —
 * as duas tabelas de roteamento (slug + prefixo do payload → use case)
 * DEVEM ficar em sincronia; nunca duplicar esses literais inline.
 */

export const INTERVIEW_INVITE_SLUG = 'qualified_worker_request';
export const LEGACY_INVITE_SLUG = 'qualified_worker';
export const SLOT_CONFIRMED_SLUG = 'qualified_worker_response';
export const REMINDER_CONFIRM_SLUG = 'qualified_reminder_confirm';
export const REMINDER_RESCHEDULE_SLUG = 'qualified_reminder_reschedule';
export const REMINDER_REASON_SLUG = 'qualified_reminder_reason';

/** Todos os slugs do fluxo de entrevista — usado para filtrar "não é nosso fluxo". */
export const INTERVIEW_SLUGS = new Set([
  INTERVIEW_INVITE_SLUG,
  LEGACY_INVITE_SLUG,
  SLOT_CONFIRMED_SLUG,
  REMINDER_CONFIRM_SLUG,
  REMINDER_RESCHEDULE_SLUG,
  REMINDER_REASON_SLUG,
]);
