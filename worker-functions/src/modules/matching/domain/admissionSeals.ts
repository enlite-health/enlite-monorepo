import type { AdmissionMessageKind, AdmissionMessageStatus } from '../application/ports/AdmissionMessagingPorts';
import { MAX_RESEND_ATTEMPT, RESENDABLE_STATUSES } from '../application/ports/AdmissionMessagingPorts';

/**
 * Selos de saúde da reunião na aba Admissão (spec 049 §4.5): o que a tela mostra, derivado de `admission_messages`
 * (a verdade da mensageria) e das colunas da reunião. Função PURA: sem relógio nem banco (o `now` entra por parâmetro).
 */
export type MessageSeal =
  | 'none'
  | 'scheduled'
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'no_consent'
  | 'skipped'
  | 'cancelled';

export interface MessageSealView {
  seal: MessageSeal;
  /** Tentativa mais recente (0 = envio original; 1 e 2 = reenvios). null = sem linha. */
  attempt: number | null;
  /** O botão "reenviar" pode aparecer: falhou, dentro do teto, reunião ativa e (lembrete) antes do início. */
  canResend: boolean;
}

export interface SealMessageRow {
  kind: AdmissionMessageKind;
  attempt: number;
  status: AdmissionMessageStatus;
}

export interface SealAppointmentFacts {
  status: string;
  slotStart: Date;
  reminderTaskName: string | null;
}

const BY_STATUS: Record<AdmissionMessageStatus, MessageSeal> = {
  claimed: 'pending',
  sent: 'sent',
  delivered: 'delivered',
  read: 'delivered',
  failed: 'failed',
  undelivered: 'failed',
  send_failed: 'failed',
  cancelled: 'cancelled',
  skipped_test: 'skipped',
  skipped_no_phone: 'skipped',
  skipped_no_template: 'skipped',
  skipped_no_consent: 'no_consent',
};

export function sealForMessage(
  kind: AdmissionMessageKind,
  rows: readonly SealMessageRow[],
  appt: SealAppointmentFacts,
  now: Date,
): MessageSealView {
  const latest = rows
    .filter((r) => r.kind === kind)
    .reduce<SealMessageRow | null>((acc, r) => (acc === null || r.attempt > acc.attempt ? r : acc), null);

  if (!latest) {
    if (appt.status === 'cancelled') return { seal: 'cancelled', attempt: null, canResend: false };
    if (kind === 'reminder_30min' && appt.status === 'booked' && appt.reminderTaskName) {
      return { seal: 'scheduled', attempt: null, canResend: false };
    }
    return { seal: 'none', attempt: null, canResend: false };
  }

  const canResend =
    appt.status === 'booked' &&
    RESENDABLE_STATUSES.includes(latest.status) &&
    latest.attempt < MAX_RESEND_ATTEMPT &&
    (kind !== 'reminder_30min' || appt.slotStart.getTime() > now.getTime());

  return { seal: BY_STATUS[latest.status], attempt: latest.attempt, canResend };
}
