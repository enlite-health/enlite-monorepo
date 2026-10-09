/**
 * Portas da mensageria de admissão (spec 049, F2).
 *
 * Tudo que o serviço precisa do mundo de fora passa por aqui: o armazém de mensagens (claim único no BANCO),
 * a trilha append-only e o agendador do lembrete (Cloud Tasks). Em teste entra dublê; o adapter real lança se
 * for instanciado com NODE_ENV=test (ver `admissionExternals.ts`).
 */

export type AdmissionMessageKind = 'confirmation' | 'reminder_30min';

export type AdmissionMessageStatus =
  | 'claimed'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'undelivered'
  | 'send_failed'
  | 'cancelled'
  | 'skipped_test'
  | 'skipped_no_consent'
  | 'skipped_no_phone'
  | 'skipped_no_template';

export type AdmissionSkipStatus = Extract<
  AdmissionMessageStatus,
  'cancelled' | 'skipped_test' | 'skipped_no_consent' | 'skipped_no_phone' | 'skipped_no_template'
>;

/** Estados em que o reenvio humano é permitido (spec §4.2.1). */
export const RESENDABLE_STATUSES: readonly AdmissionMessageStatus[] = ['send_failed', 'failed', 'undelivered'];

/** Teto de reenvios por mensagem: tentativa 0 é o envio original; 1 e 2 são reenvios. */
export const MAX_RESEND_ATTEMPT = 2;

export interface AdmissionMessageRecord {
  id: string;
  appointmentId: string;
  kind: AdmissionMessageKind;
  attempt: number;
  status: AdmissionMessageStatus;
  twilioSid: string | null;
}

export interface AdmissionMessageStore {
  /**
   * O claim: `INSERT … ON CONFLICT DO NOTHING RETURNING id`. Devolve o id de quem GANHOU e `null` para quem perdeu.
   * Só quem ganha envia.
   */
  claim(input: {
    appointmentId: string;
    kind: AdmissionMessageKind;
    attempt: number;
    requestedByUid?: string | null;
  }): Promise<string | null>;
  setStatus(id: string, status: AdmissionMessageStatus, twilioSid?: string | null): Promise<void>;
  /** Tentativas desta mensagem, da mais antiga para a mais nova. */
  listAttempts(appointmentId: string, kind: AdmissionMessageKind): Promise<AdmissionMessageRecord[]>;
  /** Para o reenvio: início e estado da reunião (null = não existe). */
  loadAppointmentWindow(appointmentId: string): Promise<{ slotStart: Date; status: string } | null>;
  /**
   * Callback da Twilio: aplica o status ao SID sem regredir (entregue não volta a enviado). Devolve a linha só se mudou.
   */
  applyDeliveryStatus(twilioSid: string, status: 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered'): Promise<AdmissionMessageRecord | null>;
}

export interface AdmissionEventInput {
  appointmentId: string;
  kind: string;
  outcome?: string | null;
  reason?: string | null;
  /** SÓ ids (SID, nome da task, tentativa). Nunca telefone, nome, texto. */
  ref?: Record<string, string | number | boolean | null> | null;
}

export interface AdmissionEventSink {
  append(event: AdmissionEventInput): Promise<void>;
}

export type ReminderScheduleResult =
  | { status: 'scheduled'; taskName: string }
  | { status: 'already_exists' }
  | { status: 'disabled' };

/** Agendador do lembrete de 30 min. O nome (`taskId`) é determinístico: o Cloud Tasks deduplica por ele. */
export interface AdmissionReminderTasksPort {
  schedule(input: { taskId: string; appointmentId: string; runAtISO: string }): Promise<ReminderScheduleResult>;
  cancel(taskName: string): Promise<void>;
}

export class AdmissionRealAdapterInTestError extends Error {
  constructor(adapter: string) {
    super(`${adapter}: adapter real de admissão não pode ser instanciado com NODE_ENV=test (use o dublê)`);
    this.name = 'AdmissionRealAdapterInTestError';
  }
}
