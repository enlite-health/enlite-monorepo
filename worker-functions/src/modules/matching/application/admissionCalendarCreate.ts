import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { AdmissionEventRepository } from '../infrastructure/AdmissionEventRepository';
import type { CreateEventParams } from '../infrastructure/AdmissionCalendarService';
import type { AdmissionCalendarPort } from './ports/AdmissionCalendarPort';

/**
 * Criação do evento no Google com novas tentativas e compensação (spec 050 F9, R-34 e R-35).
 *
 * Premissa medida na documentação oficial do `events.insert`: o id do evento pode ser escolhido pelo cliente ("characters
 * allowed in the ID are those used in base32hex encoding... the length of the ID must be between 5 and 1024") e o guia de
 * criação diz que isso "previne a criação duplicada se a operação falha depois de executada no backend do Calendar". A
 * documentação NÃO diz o que a API responde a um id repetido ("we cannot guarantee that ID collisions will be detected at event
 * creation time"). Por isso: (a) o id é fixo por reunião, (b) a resposta a id repetido (409) é resolvida LENDO o evento por id
 * (`googleCalendarCreateResponse.ts`), nunca supondo, e (c) evento criado mas sem id/link do Meet é apagado e a tentativa
 * seguinte usa OUTRO id (um id apagado não é reaproveitável).
 */

/** Esperas antes da 2ª e da 3ª tentativa (poucos segundos no total: o paciente está esperando a resposta). */
export const CALENDAR_CREATE_RETRY_DELAYS_MS: readonly number[] = [300, 1000];

/** Nome do evento de trilha (`admission_events.kind`) e do log de erro. O alerta da F12 filtra por `CALENDAR_CREATE_FAILED_LOG`. */
export const CALENDAR_CREATE_FAILED_EVENT = 'calendar_create_failed';
export const CALENDAR_CREATE_FAILED_LOG = 'admission.calendar_create_failed';

/** O Google não criou o evento (ou o devolveu sem id/link do Meet) depois de todas as tentativas. A reserva NÃO existe mais. */
export class CalendarCreateFailedError extends Error {
  readonly code = 'CALENDAR_CREATE_FAILED';
  constructor(readonly reason: 'create_error' | 'empty_event_or_link') {
    super('No pudimos crear la reunión en Google. No se agendó nada. Probá de nuevo.');
    this.name = 'CalendarCreateFailedError';
  }
}

/** Id de evento válido no Google (base32hex: 0-9 a-v): uuid sem hífens (0-9 a-f) + letra da geração. */
export function calendarEventIdFor(appointmentId: string, generation: number): string {
  return `${appointmentId.replace(/-/g, '').toLowerCase()}${'ghijklmnopqrstuv'[generation] ?? 'v'}`;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Apagar o evento é compensação: falha aqui vira log, nunca esconde a causa original. */
async function deleteQuietly(calendar: AdmissionCalendarPort, p: CreateEventParams, eventId: string, appointmentId: string): Promise<void> {
  try {
    await calendar.deleteEvent(p.calendarId, eventId, p.impersonateEmail);
  } catch {
    logger.warn({ appointmentId }, 'admission.calendar_create_cleanup_failed');
  }
}

export async function createEventWithRetry(
  calendar: AdmissionCalendarPort,
  params: Omit<CreateEventParams, 'eventId'>,
  appointmentId: string,
  delaysMs: readonly number[] = CALENDAR_CREATE_RETRY_DELAYS_MS,
): Promise<{ eventId: string; meetLink: string }> {
  let generation = 0;
  let reason: CalendarCreateFailedError['reason'] = 'create_error';
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    if (attempt > 0) await sleepMs(delaysMs[attempt - 1]);
    const eventId = calendarEventIdFor(appointmentId, generation);
    try {
      const created = await calendar.createEventWithMeet({ ...params, eventId });
      if (created.eventId && created.meetLink) return created;
      // R-35: evento sem id ou sem link do Meet não é confirmação. O que existir é apagado; o id apagado não se reaproveita.
      reason = 'empty_event_or_link';
      if (created.eventId) await deleteQuietly(calendar, params, created.eventId, appointmentId);
      generation += 1;
    } catch {
      // Resposta perdida: o evento pode existir. Mesma geração = mesmo id, e o Google não duplica.
      reason = 'create_error';
    }
    logger.warn({ appointmentId, attempt: attempt + 1, reason }, 'admission.calendar_create_retry');
  }
  if (reason === 'create_error') await deleteQuietly(calendar, params, calendarEventIdFor(appointmentId, generation), appointmentId);
  throw new CalendarCreateFailedError(reason);
}

/**
 * COMPENSAÇÃO (R-34): a reserva que não tem evento deixa de segurar o horário. Uma só função, exportada, porque a F10 a chama
 * de um job (reserva `booked` sem evento há mais de N minutos). O UPDATE só pega linha ainda `booked` e SEM evento: reserva que
 * ganhou evento no meio do caminho, ou já cancelada, não é tocada. Devolve `true` se compensou. Trilha e status na mesma transação.
 */
export async function releaseReservationWithoutEvent(
  appointmentId: string,
  reason: string,
  db: Pool = DatabaseConnection.getInstance().getPool(),
): Promise<boolean> {
  // `withActorContext` (não `db.connect()` cru): sob RLS a conexão crua chega sem identidade e a escrita é recusada
  // (`rls_session_without_identity`). O helper abre a transação já com o contexto da request (staff, público ou job).
  const released = await withActorContext(db, async (client) => {
    const res = await client.query(
      `UPDATE admission_appointments SET status = 'calendar_failed', updated_at = now()
        WHERE id = $1 AND status = 'booked' AND calendar_event_id IS NULL`,
      [appointmentId],
    );
    if (res.rowCount === 0) return false;
    await new AdmissionEventRepository(db).append({ appointmentId, kind: CALENDAR_CREATE_FAILED_EVENT, outcome: 'failed', reason }, client);
    return true;
  });
  if (!released) return false;
  logger.error({ appointmentId, reason }, CALENDAR_CREATE_FAILED_LOG);
  return true;
}
