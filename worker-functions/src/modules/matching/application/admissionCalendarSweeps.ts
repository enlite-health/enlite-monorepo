import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { getAdmissionCountryConfig, isAdmissionCountry } from '../domain/admissionCountries';
import type { AdmissionLogger } from './AdmissionMessagingService';
import type { AdmissionCalendarPort } from './ports/AdmissionCalendarPort';
import type { AdmissionEventSink } from './ports/AdmissionMessagingPorts';
import { calendarEventIdFor, releaseReservationWithoutEvent } from './admissionCalendarCreate';

/**
 * As duas varreduras de Google do job de 15 min (spec 050 F10): R-36 (apagar o evento da reunião cancelada que o Google não
 * apagou) e R-37 (reserva `booked` sem evento). Moram aqui, e não no job nem no painel, porque os dois já estão no teto de linhas.
 *
 * Nomes que a F12 transforma em filtro de alerta: `CANCEL_EVENT_FAILED_LOG`, `CALENDAR_CREATE_FAILED_LOG` (admissionCalendarCreate,
 * emitido pela compensação com `reason=booked_without_event`) e `CALENDAR_SWEEP_FAILED_LOG`. Log e trilha: só ids, nunca texto de erro.
 */

/** Esperas antes de cada nova tentativa de apagar, no clique do Cancelar (a pessoa está esperando a resposta). */
export const CANCEL_DELETE_RETRY_DELAYS_MS: readonly number[] = [300];

export const CANCEL_EVENT_FAILED_LOG = 'admission.cancel.calendar_event_failed';
export const CANCEL_CALENDAR_FAILED_EVENT = 'cancel_calendar_failed';
export const CANCEL_CALENDAR_DELETED_EVENT = 'cancel_calendar_deleted';
export const CALENDAR_SWEEP_FAILED_LOG = 'admission.calendar_sweep.failed';

/** R-37: reserva sem evento só é órfã depois disto (a criação normal leva segundos). */
export const ORPHAN_RESERVATION_MINUTES = 5;
/** Mesma janela dos detectores de silêncio: reserva velha demais é história, não alarme novo. */
export const ORPHAN_RESERVATION_WINDOW_HOURS = 72;
export const ORPHAN_REASON = 'booked_without_event';
const SWEEP_LIMIT = 100;

export interface CalendarSweepSummary {
  /** Reuniões canceladas com o evento do Google ainda pendente no início da execução. */
  cancelEventPending: number;
  /** Dessas, as que a execução conseguiu apagar. */
  cancelEventDeleted: number;
  /** Reservas `booked` sem evento compensadas. */
  orphanReleased: number;
}

export const EMPTY_CALENDAR_SWEEP: CalendarSweepSummary = { cancelEventPending: 0, cancelEventDeleted: 0, orphanReleased: 0 };

/**
 * "Cancelada, evento do Google pendente": cancelada, com evento, com a falha registrada na trilha e SEM o apagar tardio.
 * A trilha é a fonte (só-acréscimo): nenhuma coluna nova. `a` = alias da tabela `admission_appointments`.
 */
export function pendingCalendarDeleteSql(a: string): string {
  return `(${a}.status = 'cancelled' AND ${a}.calendar_event_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM admission_events ef WHERE ef.appointment_id = ${a}.id AND ef.kind = '${CANCEL_CALENDAR_FAILED_EVENT}')
     AND NOT EXISTS (SELECT 1 FROM admission_events ed WHERE ed.appointment_id = ${a}.id AND ed.kind = '${CANCEL_CALENDAR_DELETED_EVENT}'))`;
}

/** Id da agenda do país da reunião (variável de ambiente por país). Lança se o país ou a variável não existem. */
export function admissionCalendarIdFor(country: string): string {
  if (!isAdmissionCountry(country)) throw new Error('bad_country');
  const id = process.env[getAdmissionCountryConfig(country).admissionCalendarIdEnv];
  if (!id) throw new Error('missing_calendar_id');
  return id;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** O Google disse 404: o evento não existe mais (`CalendarEventNotFoundError.code`). Reconhecido por `code`, sem importar a infraestrutura. */
export function isEventNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EVENT_NOT_FOUND';
}

export type CalendarDeleteOutcome = 'deleted' | 'not_found' | 'failed';

/**
 * Apaga o evento com novas tentativas curtas. `deleted` = apagou (ou já estava apagado, 410); `not_found` = 404, o evento não existe
 * mais — conta como "já apagado" e NÃO repete; `failed` = esgotou as tentativas. Nunca lança.
 */
export async function deleteCalendarEventWithRetry(
  calendar: Pick<AdmissionCalendarPort, 'deleteEvent'>,
  args: { calendarId: string; eventId: string; impersonateEmail: string },
  delaysMs: readonly number[] = CANCEL_DELETE_RETRY_DELAYS_MS,
): Promise<CalendarDeleteOutcome> {
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    if (attempt > 0) await sleepMs(delaysMs[attempt - 1]);
    try {
      await calendar.deleteEvent(args.calendarId, args.eventId, args.impersonateEmail);
      return 'deleted';
    } catch (err) {
      if (isEventNotFound(err)) return 'not_found';
      // próxima tentativa; ao esgotar quem chama registra (sem o texto do erro: pode ecoar dado)
    }
  }
  return 'failed';
}

export interface AdmissionCalendarSweepsDeps {
  db: Pool;
  calendar: Pick<AdmissionCalendarPort, 'deleteEvent'>;
  events: AdmissionEventSink;
  impersonateEmail: string;
  log?: AdmissionLogger;
  /** Espera entre tentativas do apagar tardio; o job roda de 15 em 15 min, então 1 tentativa por reunião por execução basta. */
  retryDelaysMs?: readonly number[];
}

export class AdmissionCalendarSweeps {
  private readonly log: AdmissionLogger;

  constructor(private readonly deps: AdmissionCalendarSweepsDeps) {
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
  }

  async run(now: Date): Promise<CalendarSweepSummary> {
    const out = { ...EMPTY_CALENDAR_SWEEP };
    try {
      Object.assign(out, await this.retryPendingCancelDeletes());
    } catch {
      this.log.error({ sweep: 'cancel_delete' }, CALENDAR_SWEEP_FAILED_LOG);
    }
    try {
      out.orphanReleased = await this.releaseOrphanReservations(now);
    } catch {
      this.log.error({ sweep: 'orphan_reservation' }, CALENDAR_SWEEP_FAILED_LOG);
    }
    return out;
  }

  /** R-36: repete o apagar das reuniões canceladas cujo evento sobrou. UM log de alarme por execução, com a contagem e os ids. */
  private async retryPendingCancelDeletes(): Promise<Pick<CalendarSweepSummary, 'cancelEventPending' | 'cancelEventDeleted'>> {
    const { db, calendar, events, impersonateEmail } = this.deps;
    const { rows } = await db.query<{ id: string; country: string; calendar_event_id: string }>(
      `SELECT a.id, a.country, a.calendar_event_id
         FROM admission_appointments a
        WHERE ${pendingCalendarDeleteSql('a')}
        ORDER BY a.updated_at, a.id
        LIMIT ${SWEEP_LIMIT}`,
    );
    const stillPending: string[] = [];
    let deleted = 0;
    for (const r of rows) {
      let outcome: CalendarDeleteOutcome = 'failed';
      try {
        outcome = await deleteCalendarEventWithRetry(
          calendar,
          { calendarId: admissionCalendarIdFor(r.country), eventId: r.calendar_event_id, impersonateEmail },
          this.deps.retryDelaysMs ?? [],
        );
      } catch {
        outcome = 'failed'; // país ou agenda sem configuração: continua pendente e alarma
      }
      if (outcome === 'failed') {
        stillPending.push(r.id);
        continue;
      }
      await events.append({ appointmentId: r.id, kind: CANCEL_CALENDAR_DELETED_EVENT, outcome: 'deleted', reason: outcome === 'not_found' ? 'not_found' : 'job_retry' });
      this.log.info({ appointmentId: r.id }, 'admission.cancel.calendar_event_deleted_late');
      deleted += 1;
    }
    if (stillPending.length > 0) {
      this.log.error({ count: stillPending.length, appointmentIds: stillPending }, CANCEL_EVENT_FAILED_LOG);
    }
    return { cancelEventPending: rows.length, cancelEventDeleted: deleted };
  }

  /**
   * R-37: `booked` sem evento há mais de 5 min é compensada pela MESMA função da F9 (status `calendar_failed`, evento
   * `calendar_create_failed`, log de erro). Só depois de compensar tenta apagar o evento de id fixo que a queda do processo
   * possa ter deixado no Google (a reserva já não segura o horário, então apagar não tem como atingir reunião viva).
   */
  private async releaseOrphanReservations(now: Date): Promise<number> {
    const { db, calendar, impersonateEmail } = this.deps;
    const { rows } = await db.query<{ id: string; country: string }>(
      `SELECT a.id, a.country
         FROM admission_appointments a
        WHERE a.status = 'booked'
          AND a.calendar_event_id IS NULL
          AND a.created_at < $1::timestamptz - make_interval(mins => ${ORPHAN_RESERVATION_MINUTES})
          AND a.created_at >= $1::timestamptz - make_interval(hours => ${ORPHAN_RESERVATION_WINDOW_HOURS})
        ORDER BY a.created_at, a.id
        LIMIT ${SWEEP_LIMIT}`,
      [now],
    );
    let released = 0;
    for (const r of rows) {
      if (!(await releaseReservationWithoutEvent(r.id, ORPHAN_REASON, db))) continue;
      released += 1;
      try {
        await calendar.deleteEvent(admissionCalendarIdFor(r.country), calendarEventIdFor(r.id, 0), impersonateEmail);
      } catch (err) {
        // 404 é o caso normal (a queda foi antes de criar o evento): não é falha. Qualquer outro erro é.
        if (!isEventNotFound(err)) this.log.warn({ appointmentId: r.id }, 'admission.calendar_create_cleanup_failed');
      }
    }
    return released;
  }
}
