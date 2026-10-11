import type { Pool } from 'pg';
import { logger, loggingAls } from '@shared/logging';
import type { AdmissionCountry } from '../domain/admissionCountries';
import { sealForMessage, type MessageSealView, type SealMessageRow } from '../domain/admissionSeals';
import type { InterviewHost, InterviewHostRepository } from '../infrastructure/InterviewHostRepository';
import type { AdmissionLogger, AdmissionMessagingService, DispatchOutcome } from './AdmissionMessagingService';
import { PAID_REHEARSAL_RELEASED_EVENT, PAID_REHEARSAL_TTL_MS } from '../domain/admissionRealm';
import {
  AppointmentNotCancellableError,
  AppointmentNotFoundError,
  PaidRehearsalAlreadyActiveError,
  PaidRehearsalNotAllowedError,
  ResendInProgressError,
} from './AdmissionPanelErrors';
import { PatientNotFoundError } from './AdmissionSchedulingService';
import type { AdmissionCalendarPort } from './ports/AdmissionCalendarPort';
import type { TactiqLinkGate, TactiqLinkState } from './ports/TactiqPorts';
import { isHostApt } from './admissionHostEligibility';
import {
  CANCEL_CALENDAR_DELETED_EVENT,
  CANCEL_CALENDAR_FAILED_EVENT,
  type CalendarDeleteOutcome,
  CANCEL_EVENT_FAILED_LOG,
  admissionCalendarIdFor,
  deleteCalendarEventWithRetry,
  pendingCalendarDeleteSql,
} from './admissionCalendarSweeps';
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
  /** Cancelada e o Google ainda não apagou o evento (R-36): o job repete até apagar. */
  calendarEventPending: boolean;
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

export interface PaidRehearsalRelease {
  appointmentId: string;
  /** Fim da liberação (ISO): `agora + 48 h`. Depois dele a reunião volta a valer como `test`. */
  expiresAt: string;
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
  calendar_event_pending: boolean;
}

export interface AdmissionPanelDeps {
  db: Pool;
  calendar: AdmissionCalendarPort;
  reminderTasks: AdmissionReminderTasksPort;
  events: AdmissionEventSink;
  messaging: AdmissionMessagingService;
  hosts: Pick<InterviewHostRepository, 'listActiveByCountry'>;
  /** Vínculo do Tactiq por responsável (spec 049 F4): a lista de hosts devolve `linked` e o motivo. */
  tactiq: TactiqLinkGate;
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

  /** Responsáveis do roster do país, cada um com o estado do vínculo do Tactiq (`linked` → pode ser escolhido). */
  async listHosts(country: AdmissionCountry): Promise<Array<InterviewHost & { linked: boolean; linkState: TactiqLinkState }>> {
    const hosts = await this.deps.hosts.listActiveByCountry(country);
    const states = await this.deps.tactiq.statesFor(hosts.map((h) => h.email));
    return hosts.map((h) => {
      const linkState = states.get(h.email.toLowerCase()) ?? 'missing';
      return { ...h, linked: isHostApt(linkState), linkState };
    });
  }

  async list(patientId: string): Promise<AdmissionAppointmentView[]> {
    const { db } = this.deps;
    const patient = await db.query(`SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL`, [patientId]);
    if (patient.rows.length === 0) throw new PatientNotFoundError();

    const appts = await db.query<AppointmentRow>(
      `SELECT a.id, a.admission_code, a.created_via, a.country, a.host_email, a.slot_start, a.slot_end, a.status,
              a.meet_link, a.reminder_task_name, a.import_status,
              (SELECT d.id FROM patient_documents d WHERE d.source_appointment_id = a.id LIMIT 1) AS document_id,
              ${pendingCalendarDeleteSql('a')} AS calendar_event_pending
         FROM admission_appointments a
        WHERE a.patient_id = $1 AND a.status <> 'calendar_failed'
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
        calendarEventPending: a.calendar_event_pending,
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
      const eventId = row.calendar_event_id;
      let outcome: CalendarDeleteOutcome = 'failed';
      try {
        const calendarId = admissionCalendarIdFor(row.country);
        outcome = await deleteCalendarEventWithRetry(this.deps.calendar, { calendarId, eventId, impersonateEmail: this.deps.impersonateEmail });
      } catch {
        outcome = 'failed';
      }
      calendarEventDeleted = outcome !== 'failed';
      if (outcome === 'not_found') await this.append(appointmentId, CANCEL_CALENDAR_DELETED_EVENT, { outcome: 'deleted', reason: 'not_found' });
      if (calendarEventDeleted) {
        this.log.info({ appointmentId }, 'admission.cancel.calendar_event_deleted');
      } else {
        this.log.error({ appointmentId }, CANCEL_EVENT_FAILED_LOG);
        await this.append(appointmentId, CANCEL_CALENDAR_FAILED_EVENT, { outcome: 'failed', reason: 'delete_event' });
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

  /**
   * Ensaio pago (spec 050 R-19): libera UMA reunião de paciente de teste por 48 h. A liberação é um evento da trilha
   * (`paid_rehearsal_released`, `ref = { actorUid, expiresAt }`, só id e carimbo) — a trilha é só-acréscimo, então não há
   * "revogar": o prazo é o único fim. Quem LÊ a liberação é `admissionRealm` (via `rehearsalUntilSql`), nunca este serviço.
   *
   * 404: paciente/reunião inexistente, de outro paciente ou de outro país (a RLS esconde o paciente) — igual às rotas irmãs.
   * 409: paciente que NÃO é de teste (não existe ensaio de paciente real), reunião não `booked`, ou liberação ainda vigente.
   * Sequencial: liberar de novo com liberação vigente → 409. Simultâneo: o `INSERT … WHERE NOT EXISTS` não tem lock nem índice único
   * (READ COMMITTED), então dois cliques ao mesmo tempo PODEM gravar 2 eventos e responder 2×201; o prazo não se estende de forma útil (os
   * dois `expiresAt` diferem em ms) e `admissionRealm` lê o mais recente.
   */
  async releasePaidRehearsal(input: { patientId: string; appointmentId: string; actorUid: string }): Promise<PaidRehearsalRelease> {
    const { db } = this.deps;
    const { patientId, appointmentId, actorUid } = input;

    const patient = await db.query<{ is_test: boolean }>(
      `SELECT is_test IS TRUE AS is_test FROM patients WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    if (patient.rows.length === 0) throw new PatientNotFoundError();
    const appt = await db.query<{ status: string }>(
      `SELECT status FROM admission_appointments WHERE id = $1 AND patient_id = $2`,
      [appointmentId, patientId],
    );
    if (appt.rows.length === 0) throw new AppointmentNotFoundError();
    if (!patient.rows[0].is_test) throw new PaidRehearsalNotAllowedError('patient_not_test');
    if (appt.rows[0].status !== 'booked') throw new PaidRehearsalNotAllowedError('appointment_not_booked');

    const now = this.now();
    const expiresAt = new Date(now.getTime() + PAID_REHEARSAL_TTL_MS).toISOString();
    const inserted = await db.query(
      `INSERT INTO admission_events (appointment_id, kind, outcome, ref, trace_id)
       SELECT $1, '${PAID_REHEARSAL_RELEASED_EVENT}', 'released', $2::jsonb, $3
        WHERE NOT EXISTS (SELECT 1 FROM admission_events e
                           WHERE e.appointment_id = $1 AND e.kind = '${PAID_REHEARSAL_RELEASED_EVENT}'
                             AND (e.ref->>'expiresAt')::timestamptz > $4::timestamptz)
       RETURNING id`,
      [appointmentId, JSON.stringify({ actorUid, expiresAt }), loggingAls?.getStore?.()?.traceId ?? null, now.toISOString()],
    );
    if (inserted.rows.length === 0) throw new PaidRehearsalAlreadyActiveError();
    this.log.info({ appointmentId }, 'admission.paid_rehearsal_released');
    return { appointmentId, expiresAt };
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
