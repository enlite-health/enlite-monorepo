import { logger } from '@shared/logging';
import type { AdmissionRealm } from '../domain/admissionRealm';
import type { AdmissionWhatsAppSender } from '../infrastructure/admissionTemplates';
import type {
  AdmissionEventSink,
  AdmissionMessageKind,
  AdmissionMessageStore,
  AdmissionSkipStatus,
} from './ports/AdmissionMessagingPorts';
import { MAX_RESEND_ATTEMPT, RESENDABLE_STATUSES } from './ports/AdmissionMessagingPorts';
import { ResendLimitReached, ResendNotAllowed } from './AdmissionMessagingErrors';

/** O que o chamador decide DEPOIS de ganhar o claim: pular (com motivo escrito) ou enviar este conteúdo. */
export type MessageResolution =
  | { skip: AdmissionSkipStatus }
  | { send: { to: string; contentSid: string; vars: Record<string, string>; realm: AdmissionRealm } };

/** Monta o conteúdo de uma mensagem a partir do id da reunião (usado pelo reenvio). */
export interface AdmissionMessageResolver {
  resolve(kind: AdmissionMessageKind, appointmentId: string): Promise<MessageResolution>;
}

export type DispatchOutcome = 'sent' | 'send_failed' | 'skipped' | 'duplicate_blocked';

export interface DispatchResult {
  outcome: DispatchOutcome;
  messageId?: string;
  skip?: AdmissionSkipStatus;
}

/** Subconjunto do logger pino que o serviço usa — permite capturar a saída em teste. */
export interface AdmissionLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const PREFIX: Record<AdmissionMessageKind, string> = { confirmation: 'confirmation', reminder_30min: 'reminder' };

/**
 * AdmissionMessagingService — o freio anti-duplicata da mensageria de admissão (spec 049 §4.2, M1/M3).
 *
 * Toda mensagem esperada é UMA linha em `admission_messages`, com UNIQUE(appointment_id, kind, attempt). Quem envia é
 * SÓ quem ganha o `INSERT … ON CONFLICT DO NOTHING RETURNING`: o segundo `onBooked` e a segunda entrega do Cloud Tasks
 * perdem o claim, gravam `duplicate_blocked` e NÃO enviam. Todo skip (teste, sem consentimento, sem telefone, sem
 * template) vira linha com o motivo. Falha de envio vira `send_failed` e NÃO reenvia sozinha: reenviar é ato humano
 * explícito, com teto (`requestResend`).
 *
 * Log: só ids/enum. Nunca telefone, nome, e-mail, conteúdo de mensagem nem o texto de erro da Twilio (que pode ecoar o número).
 */
export class AdmissionMessagingService {
  constructor(
    private readonly store: AdmissionMessageStore,
    private readonly events: AdmissionEventSink,
    private readonly whatsapp: AdmissionWhatsAppSender,
    private readonly resolver: AdmissionMessageResolver | null = null,
    private readonly log: AdmissionLogger = logger as unknown as AdmissionLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async dispatch(input: {
    appointmentId: string;
    kind: AdmissionMessageKind;
    attempt?: number;
    requestedByUid?: string | null;
    resolve: () => Promise<MessageResolution>;
  }): Promise<DispatchResult> {
    const { appointmentId, kind } = input;
    const attempt = input.attempt ?? 0;
    const prefix = attempt > 0 ? 'resend' : PREFIX[kind];

    const messageId = await this.store.claim({
      appointmentId,
      kind,
      attempt,
      requestedByUid: input.requestedByUid ?? null,
    });
    if (!messageId) {
      await this.record(appointmentId, 'duplicate_blocked', { outcome: 'blocked', reason: 'claim_lost', ref: { kind, attempt } });
      return { outcome: 'duplicate_blocked' };
    }
    await this.record(
      appointmentId,
      attempt > 0 ? 'resend_requested' : `${PREFIX[kind]}_claimed`,
      { outcome: 'claimed', ref: { kind, attempt, messageId, ...(input.requestedByUid ? { requestedByUid: input.requestedByUid } : {}) } },
    );

    let resolution: MessageResolution;
    try {
      resolution = await input.resolve();
    } catch {
      await this.safeSetStatus(messageId, 'send_failed');
      await this.record(appointmentId, `${prefix}_failed`, { outcome: 'failed', reason: 'resolve_error', ref: { kind, attempt, messageId } });
      return { outcome: 'send_failed', messageId };
    }

    if ('skip' in resolution) {
      await this.safeSetStatus(messageId, resolution.skip);
      await this.record(appointmentId, resolution.skip, { outcome: 'skipped', reason: resolution.skip, ref: { kind, attempt, messageId } });
      return { outcome: 'skipped', messageId, skip: resolution.skip };
    }

    const { to, contentSid, vars, realm } = resolution.send;
    let externalId: string | null = null;
    // R-20: o rastro contável sai ANTES do envio pago (só ids e o `realm` — nunca telefone, nome ou texto).
    this.log.info({ provider: 'twilio', appointmentId, realm }, 'admission.paid_call');
    try {
      const res = await this.whatsapp.sendWithContentSid(to, contentSid, vars);
      if (!res.isFailure) externalId = res.getValue().externalId;
    } catch {
      externalId = null;
    }
    if (!externalId) {
      await this.safeSetStatus(messageId, 'send_failed');
      await this.record(appointmentId, `${prefix}_failed`, { outcome: 'failed', reason: 'send_failed', ref: { kind, attempt, messageId } });
      return { outcome: 'send_failed', messageId };
    }
    await this.safeSetStatus(messageId, 'sent', externalId);
    await this.record(appointmentId, `${prefix}_sent`, { outcome: 'sent', ref: { kind, attempt, messageId, twilioSid: externalId } });
    return { outcome: 'sent', messageId };
  }

  /**
   * Reenvio humano e explícito. Só para a última tentativa em `send_failed|failed|undelivered`, no máximo 2 reenvios;
   * lembrete só antes do início. Dois cliques simultâneos disputam o MESMO claim `(appt, kind, attempt+1)`: um envia, o outro
   * volta `duplicate_blocked`. A rota HTTP (F3) traduz `ResendLimitReached`/`ResendNotAllowed` em 409.
   */
  async requestResend(appointmentId: string, kind: AdmissionMessageKind, actorUid: string): Promise<DispatchResult> {
    if (!this.resolver) throw new Error('AdmissionMessagingService: reenvio exige um resolver de conteúdo');
    const attempts = await this.store.listAttempts(appointmentId, kind);
    const last = attempts[attempts.length - 1];
    if (!last) throw new ResendNotAllowed('no_message');
    if (!RESENDABLE_STATUSES.includes(last.status)) throw new ResendNotAllowed(`status_${last.status}`);
    if (last.attempt >= MAX_RESEND_ATTEMPT) throw new ResendLimitReached(kind, last.attempt);

    const window = await this.store.loadAppointmentWindow(appointmentId);
    if (!window || window.status !== 'booked') throw new ResendNotAllowed('appointment_not_booked');
    if (kind === 'reminder_30min' && window.slotStart.getTime() <= this.now().getTime()) {
      throw new ResendNotAllowed('reminder_after_start');
    }

    const resolver = this.resolver;
    return this.dispatch({
      appointmentId,
      kind,
      attempt: last.attempt + 1,
      requestedByUid: actorUid,
      resolve: () => resolver.resolve(kind, appointmentId),
    });
  }

  /** Trilha + log com o MESMO nome (`admission.<kind>`). A trilha falhar nunca derruba o envio já feito. */
  private async record(
    appointmentId: string,
    kind: string,
    extra: { outcome?: string; reason?: string; ref?: Record<string, string | number | boolean | null> },
  ): Promise<void> {
    const level = kind.endsWith('_failed') || kind === 'duplicate_blocked' ? 'warn' : 'info';
    this.log[level]({ appointmentId, ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.ref ?? {}) }, `admission.${kind}`);
    try {
      await this.events.append({ appointmentId, kind, outcome: extra.outcome ?? null, reason: extra.reason ?? null, ref: extra.ref ?? null });
    } catch {
      this.log.error({ appointmentId, event: kind }, 'admission.event.append_failed');
    }
  }

  private async safeSetStatus(id: string, status: Parameters<AdmissionMessageStore['setStatus']>[1], sid?: string): Promise<void> {
    try {
      await this.store.setStatus(id, status, sid ?? null);
    } catch {
      this.log.error({ messageId: id, status }, 'admission.message.status_update_failed');
    }
  }
}
