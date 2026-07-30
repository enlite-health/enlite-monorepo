import { DateTime } from 'luxon';
import { Result } from '@shared/utils/Result';
import { MessageSentResult } from '@modules/notification/domain/IMessagingService';
import type { AdmissionCountry } from '../domain/admissionCountries';

/**
 * admissionTemplates — WhatsApp template wiring for the admission-scheduling
 * notifications (confirmation + 30-min reminder), multi-country AR (es) / BR (pt).
 *
 * The real Twilio `contentSid` values only exist AFTER Meta approves each
 * template, so we DON'T hard-code them: each (slug + language) maps to an env
 * var. If the env var is absent (e.g. local / template not yet approved) the
 * caller logs a WARN and skips the send instead of crashing.
 *
 * Approved template bodies (documented here so the code is the source of truth;
 * the {{n}} order matches the positional contentVariables built below):
 *
 *   Confirmation es (TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES):
 *     "Hola {{1}}, tu entrevista de admisión con {{2}} quedó agendada para el
 *      {{3}} a las {{4}} hs. Ingresá a la hora por: {{5}}"
 *   Confirmation pt (TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_PT):
 *     "Olá {{1}}, sua entrevista de admissão com {{2}} foi agendada para {{3}}
 *      às {{4}}h. Acesse na hora pelo: {{5}}"
 *   Reminder es (TWILIO_TEMPLATE_ADMISSION_REMINDER_ES):
 *     "Recordatorio: tu entrevista con {{1}} es en 30 minutos ({{2}} hs).
 *      Ingresá: {{3}}"
 *   Reminder pt (TWILIO_TEMPLATE_ADMISSION_REMINDER_PT):
 *     "Lembrete: sua entrevista com {{1}} é em 30 minutos ({{2}}h). Acesse: {{3}}"
 */

export type AdmissionLang = 'es' | 'pt';

/** WhatsApp sender port — structurally satisfied by TwilioMessagingService. */
export interface AdmissionWhatsAppSender {
  sendWithContentSid(
    to: string,
    contentSid: string,
    contentVariables: Record<string, string>,
  ): Promise<Result<MessageSentResult>>;
}

/** AR speaks Spanish, BR speaks Portuguese. */
export function langForCountry(country: AdmissionCountry): AdmissionLang {
  return country === 'BR' ? 'pt' : 'es';
}

export const CONFIRMATION_ENV_VARS: Record<AdmissionLang, string> = {
  es: 'TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES',
  pt: 'TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_PT',
};

export const REMINDER_ENV_VARS: Record<AdmissionLang, string> = {
  es: 'TWILIO_TEMPLATE_ADMISSION_REMINDER_ES',
  pt: 'TWILIO_TEMPLATE_ADMISSION_REMINDER_PT',
};

/** Returns the confirmation contentSid for a language, or undefined if unset. */
export function resolveConfirmationContentSid(lang: AdmissionLang): string | undefined {
  return process.env[CONFIRMATION_ENV_VARS[lang]] || undefined;
}

/** Returns the 30-min reminder contentSid for a language, or undefined if unset. */
export function resolveReminderContentSid(lang: AdmissionLang): string | undefined {
  return process.env[REMINDER_ENV_VARS[lang]] || undefined;
}

/** Neutral host label when the interviewer has no display name. */
export function hostLabel(hostDisplayName: string | null, lang: AdmissionLang): string {
  if (hostDisplayName && hostDisplayName.trim()) return hostDisplayName.trim();
  return lang === 'pt' ? 'seu entrevistador' : 'tu entrevistador/a';
}

/**
 * Formats the slot start into human date + time in the country's timezone and
 * language. `date` is e.g. "lunes 3 de agosto" / "segunda 3 de agosto"; `time`
 * is 24h "HH:mm".
 */
export function formatAdmissionDateTime(
  slotStart: string | Date,
  timezone: string,
  lang: AdmissionLang,
): { date: string; time: string } {
  const base =
    slotStart instanceof Date
      ? DateTime.fromJSDate(slotStart, { zone: timezone })
      : DateTime.fromISO(slotStart, { zone: timezone });
  const dt = base.setLocale(lang === 'pt' ? 'pt-BR' : 'es');
  return {
    date: dt.toFormat("cccc d 'de' LLLL"),
    time: dt.toFormat('HH:mm'),
  };
}
