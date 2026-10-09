import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { getAdmissionCountryConfig, isAdmissionCountry, type AdmissionCountry } from '../domain/admissionCountries';
import { sealForMessage, type MessageSealView, type SealMessageRow } from '../domain/admissionSeals';
import type { InterviewHost, InterviewHostRepository } from '../infrastructure/InterviewHostRepository';
import type { AdmissionLogger, AdmissionMessagingService, DispatchOutcome } from './AdmissionMessagingService';
import { AppointmentNotCancellableError, AppointmentNotFoundError, ResendInProgressError } from './AdmissionPanelErrors';
import { PatientNotFoundError } from './AdmissionSchedulingService';
import type { AdmissionCalendarPort } from './ports/AdmissionCalendarPort';
import type {
  AdmissionEventSink,
  AdmissionMessageKind,
  AdmissionReminderTasksPort,
} from './ports/AdmissionMessagingPorts';

export interface AdmissionAppointmentView {
  id: string;
  admissionCode: string | null;
  createdVia: 'site' | 'panel';
  country: string;
  hostEmail: string;
  slotStart: string;
  slotEnd: string;
  status: string;
  /** Só enquanto a reunião está ativa e ainda não terminou. */
  meetLink: string | null;
  seals: {
    confirmation: MessageSealView;
    reminder: MessageSealView;
    /** Estado da importação do Tactiq (coluna `import_status`); null = reunião antiga/fora da importação. */
    import: string | null;
    /** Resumo gerado (documento `origin='admission'` ligado à reunião); null enquanto não existe. */
    document: { id: string } | null;
  };
}

export interface CancelResult {
  appointmentId: string;
  status: 'cancelled';
  /** null = nada a apagar (reunião sem evento / sem task). false = a chamada externa FALHOU (trilha `cancel_*_failed`). */
  calendarEventDeleted: boolean | null;
  reminderTaskDeleted: boolean | null;
}

export interface ResendResult {
  outcome: Exclude<DispatchOutcome, 'duplicate_blocked'>;
  skip?: string;
}

interface AppointmentRow {
  id: string;
  admission_code: string | null;
  created_via: 'site' | 'panel';
  country: string;
  host_email: string;
  slot_start: Date;
  slot_end: Date;
  status: string;
  meet_link: string | null;
  reminder_task_name: string | null;
  import_status: string | null;
  document_id: string | null;
}

export interface AdmissionPanelDeps {
  db: Pool;
  calendar: AdmissionCalendarPort;
  reminderTasks: AdmissionReminderTasksPort;
  events: AdmissionEventSink;
  messaging: AdmissionMessagingService;
  hosts: Pick<InterviewHostRepository, 'listActiveByCountry'>;
  impersonateEmail: string;
  log?: AdmissionLogger;
  now?: () => Date;
}

/**
 * AdmissionPanelService — o que o PAINEL faz com as reuniões de admissão, além de agendar (que mora no núcleo
 * `AdmissionSchedulingService.bookForHost`): listar com os selos, cancelar e reenviar a mensagem que falhou.
 *
 * Tudo roda sob a identidade/RLS da request (o `db` é o pool consciente de RLS): paciente de outro país não aparece (404).
 * Log e trilha: só ids/enum — nunca telefone, nome nem texto de erro de terceiros.
 */
export class AdmissionPanelService {
  private readonly log: AdmissionLogger;
  private readonly now: () => Date;

  constructor(private readonly deps: AdmissionPanelDeps) {
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.now = deps.now ?? (() => new Date());
  }

  async listHosts(country: AdmissionCountry): Promise<InterviewHost[]> {
    return this.deps.hosts.listActiveByCountry(country);
  }

  async list(patientId: string): Promise<AdmissionAppointmentView[]> {
    const { db } = this.deps;
    const patient = await db.query(`SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL`, [patientId]);
    if (patient.rows.length === 0) throw new PatientNotFoundError();

    const appts = await db.query<AppointmentRow>(
      `SELECT a.id, a.admission_code, a.created_via, a.country, a.host_email, a.slot_start, a.slot_end, a.status,
              a.meet_link, a.reminder_task_name, a.import_status,
              (SELECT d.id FROM patient_documents d WHERE d.source_appointment_id = a.id LIMIT 1) AS document_id
         FROM admission_appointments a
        WHERE a.patient_id = $1
        ORDER BY a.slot_start DESC`,
      [patientId],
    );
    if (appts.rows.length === 0) return [];

    const msgs = await db.query<SealMessageRow & { appointment_id: string }>(
      `SELECT appointment_id, kind, attempt, status
         FROM admission_messages
        WHERE appointment_id = ANY($1::uuid[])`,
      [appts.rows.map((r) => r.id)],
    );
    const byAppt = new Map<string, SealMessageRow[]>();
    for (const m of msgs.rows) byAppt.set(m.appointment_id, [...(byAppt.get(m.appointment_id) ?? []), m]);

    const now = this.now();
    return appts.rows.map((a) => {
      const slotStart = new Date(a.slot_start);
      const slotEnd = new Date(a.slot_end);
      const facts = { status: a.status, slotStart, reminderTaskName: a.reminder_task_name };
      const rows = byAppt.get(a.id) ?? [];
      return {
        id: a.id,
        admissionCode: a.admission_code,
        createdVia: a.created_via,
        country: a.country,
        hostEmail: a.host_email,
        slotStart: slotStart.toISOString(),
        slotEnd: slotEnd.toISOString(),
        status: a.status,
        meetLink: a.status === 'booked' && slotEnd.getTime() > now.getTime() ? a.meet_link : null,
        seals: {
          confirmation: sealForMessage('confirmation', rows, facts, now),
          reminder: sealForMessage('reminder_30min', rows, facts, now),
          import: a.import_status,
          document: a.document_id ? { id: a.document_id } : null,
        },
      };
    });
  }

  /**
   * Cancelar (spec §4.5, P1): `status='cancelled'` num UPDATE atômico (`WHERE status='booked'` — dois cancelamentos
   * simultâneos: um ganha, o outro leva 409) e só então os efeitos externos, cada um isolado: mensagens pendentes →
   * `cancelled`, task do lembrete apagada, evento apagado no Google (`sendUpdates=all`: a família é avisada pelo Google).
   * Falha externa NÃO desfaz o cancelamento: vira linha `cancel_*_failed` na trilha + log de erro + flag `false` na
   * resposta. O lembrete que escapar ainda morre no status (`AdmissionReminderService`: status != booked → não envia).
   */
  async cancel(input: { patientId: string; appointmentId: string; actorUid: string }): Promise<CancelResult> {
    const { db } = this.deps;
    const { patientId, appointmentId, actorUid } = input;

    const claimed = await db.query<{ country: string; calendar_event_id: string | null; reminder_task_name: string | null }>(
      `UPDATE admission_appointments
          SET status = 'cancelled', cancelled_at = now(), cancelled_by_uid = $3, updated_at = now()
        WHERE id = $1 AND patient_id = $2 AND status = 'booked'
        RETURNING country, calendar_event_id, reminder_task_name`,
      [appointmentId, patientId, actorUid],
    );
    const row = claimed.rows[0];
    if (!row) {
      const cur = await db.query<{ status: string }>(
        `SELECT status FROM admission_appointments WHERE id = $1 AND patient_id = $2`,
        [appointmentId, patientId],
      );
      if (cur.rows.length === 0) throw new AppointmentNotFoundError();
      throw new AppointmentNotCancellableError(cur.rows[0].status);
    }

    await this.append(appointmentId, 'cancelled', { outcome: 'cancelled', ref: { actorUid } });
    this.log.info({ appointmentId }, 'admission.cancelled');

    await db.query(
      `UPDATE admission_messages SET status = 'cancelled', updated_at = now()
        WHERE appointment_id = $1 AND status = 'claimed'`,
      [appointmentId],
    );

    let reminderTaskDeleted: boolean | null = null;
    if (row.reminder_task_name) {
      try {
        await this.deps.reminderTasks.cancel(row.reminder_task_name);
        reminderTaskDeleted = true;
        this.log.info({ appointmentId }, 'admission.cancel.reminder_task_deleted');
      } catch {
        reminderTaskDeleted = false;
        this.log.error({ appointmentId }, 'admission.cancel.reminder_task_failed');
        await this.append(appointmentId, 'cancel_reminder_task_failed', { outcome: 'failed', reason: 'delete_task' });
      }
    }

    let calendarEventDeleted: boolean | null = null;
    if (row.calendar_event_id) {
      try {
        const calendarId = this.calendarIdFor(row.country);
        await this.deps.calendar.deleteEvent(calendarId, row.calendar_event_id, this.deps.impersonateEmail);
        calendarEventDeleted = true;
        this.log.info({ appointmentId }, 'admission.cancel.calendar_event_deleted');
      } catch {
        calendarEventDeleted = false;
        this.log.error({ appointmentId }, 'admission.cancel.calendar_event_failed');
        await this.append(appointmentId, 'cancel_calendar_failed', { outcome: 'failed', reason: 'delete_event' });
      }
    }

    return { appointmentId, status: 'cancelled', calendarEventDeleted, reminderTaskDeleted };
  }

  /**
   * Reenvio humano (spec §4.2.1). Os dois perdedores viram erro de domínio para a rota mapear a 409:
   *  - as regras (`ResendNotAllowed`/`ResendLimitReached`, lançadas pelo núcleo de mensageria);
   *  - o claim perdido (`duplicate_blocked` SEM exceção) → `ResendInProgressError`.
   * Falha de envio / skip NÃO é erro de HTTP: volta como `outcome` (a tentativa foi gasta e o selo mostra o resultado).
   */
  async resend(input: { patientId: string; appointmentId: string; kind: AdmissionMessageKind; actorUid: string }): Promise<ResendResult> {
    const own = await this.deps.db.query(
      `SELECT 1 FROM admission_appointments WHERE id = $1 AND patient_id = $2`,
      [input.appointmentId, input.patientId],
    );
    if (own.rows.length === 0) throw new AppointmentNotFoundError();

    const res = await this.deps.messaging.requestResend(input.appointmentId, input.kind, input.actorUid);
    if (res.outcome === 'duplicate_blocked') throw new ResendInProgressError();
    return { outcome: res.outcome, ...(res.skip ? { skip: res.skip } : {}) };
  }

  private calendarIdFor(country: string): string {
    if (!isAdmissionCountry(country)) throw new Error('bad_country');
    const id = process.env[getAdmissionCountryConfig(country).admissionCalendarIdEnv];
    if (!id) throw new Error('missing_calendar_id');
    return id;
  }

  private async append(
    appointmentId: string,
    kind: string,
    extra: { outcome: string; reason?: string; ref?: Record<string, string> },
  ): Promise<void> {
    try {
      await this.deps.events.append({ appointmentId, kind, outcome: extra.outcome, reason: extra.reason ?? null, ref: extra.ref ?? null });
    } catch {
      this.log.error({ appointmentId, event: kind }, 'admission.event.append_failed');
    }
  }
}
