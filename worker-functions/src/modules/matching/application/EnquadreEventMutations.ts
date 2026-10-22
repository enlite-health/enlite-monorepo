import { DateTime } from 'luxon';
import type { PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import type { PubSubClient } from '@shared/events/PubSubClient';
import { ContactNoteRepository } from '../infrastructure/ContactNoteRepository';
import {
  EnquadreEventRepository,
  PARTICIPANT_LOCK_INDEX,
  type ActiveParticipantRow,
  type LockedEventRow,
} from '../infrastructure/EnquadreEventRepository';
import { getAdmissionCountryConfig, isAdmissionCountry, type AdmissionCountry } from '../domain/admissionCountries';
import { assertGuestsAllowed, parseGuestPolicy, resolveEnquadreCalendarId } from '../domain/enquadreCalendarConfig';
import {
  cancelledNoteText,
  columnOfStage,
  notMarkedNoteText,
  outcomeOfStage,
  STAGE_OF_COLUMN,
  type EnquadreColumnId,
} from '../domain/enquadreEvent';
import { assertWorkerApto, assertWorkerCanApply, WorkerNotEligibleError } from '../domain/WorkerApplicationEligibility';
import {
  EnquadreCalendarUpdateFailedError,
  EnquadreEventNotEndedError,
  EnquadreEventNotFoundError,
  EnquadreEventNotOpenError,
  EnquadreMoveRefusedError,
  EnquadreParticipantAlreadyMarkedError,
  EnquadreParticipantNotFoundError,
  EnquadreVacancyNotFoundError,
  EnquadreWorkerEmailInvalidError,
  EnquadreWorkerNotAvailableError,
} from './EnquadreEventErrors';
import {
  hasValidEmail,
  isUniqueViolation,
  type EnquadreActor,
  type EnquadreEventDetail,
  type EnquadreEventServiceDeps,
  type EnquadreViewer,
} from './EnquadreEventService';
import { moveApplicationStage } from './moveApplicationStage';
import { publishStageEvent } from './publishStageEvent';
import { isEventNotFound } from './admissionCalendarSweeps';

export interface EnquadreEventMutationsDeps extends Pick<EnquadreEventServiceDeps, 'db' | 'calendar' | 'env' | 'impersonateEmail'> {
  /** Releitura do detalhe depois do COMMIT (o mesmo `getEvent` do serviço). */
  readEvent: (vacancyId: string, eventId: string, viewer: EnquadreViewer) => Promise<EnquadreEventDetail>;
  pubsub: Pick<PubSubClient, 'publish'>;
  repo?: EnquadreEventRepository;
  now?: () => Date;
}

/**
 * EnquadreEventMutations — acrescentar/tirar convocado, cancelar, marcar resultado e encerrar o evento (spec 052, T-30c).
 * Toda mutação roda numa transação (`withActorContext`) sobre o evento TRAVADO (`FOR UPDATE`), que precisa ser da vaga da rota
 * e estar `open`. Quem chama o Google o faz DENTRO da transação: falhou → ROLLBACK, nada fica gravado. O estágio da candidatura
 * só muda por `moveApplicationStage` (nunca por SQL daqui). Log: só ids e contagens — nunca e-mail, nome ou telefone.
 */
export class EnquadreEventMutations {
  private readonly repo: EnquadreEventRepository;
  private readonly now: () => Date;

  constructor(private readonly deps: EnquadreEventMutationsDeps) {
    this.repo = deps.repo ?? new EnquadreEventRepository();
    this.now = deps.now ?? (() => new Date());
  }

  async addParticipants(vacancyId: string, eventId: string, workerIds: string[], actor: EnquadreActor): Promise<EnquadreEventDetail> {
    await withActorContext(this.deps.db, async (client) => {
      const ev = await this.requireOpen(client, vacancyId, eventId);
      const ids = [...new Set(workerIds)];
      const available = await this.repo.listAvailableWorkers(client, vacancyId, ids);
      if (available.length !== ids.length) throw new EnquadreWorkerNotAvailableError();
      const invalid = available.filter((w) => !hasValidEmail(w.email)).length;
      if (invalid > 0) throw new EnquadreWorkerEmailInvalidError(invalid);
      assertGuestsAllowed(parseGuestPolicy(this.deps.env), available.map((w) => (w.email as string).trim()));
      try {
        await this.repo.insertParticipants(client, { eventId, jobPostingId: vacancyId, workerIds: ids, addedByUid: actor.uid });
      } catch (err) {
        if (isUniqueViolation(err, PARTICIPANT_LOCK_INDEX)) throw new EnquadreWorkerNotAvailableError();
        throw err;
      }
      await this.syncAttendees(client, ev, vacancyId);
    });
    logger.info({ vacancyId, eventId, added: new Set(workerIds).size }, 'enquadre.participants_added');
    return this.deps.readEvent(vacancyId, eventId, actor);
  }

  async removeParticipant(vacancyId: string, eventId: string, participantId: string, actor: EnquadreActor): Promise<EnquadreEventDetail> {
    await withActorContext(this.deps.db, async (client) => {
      const ev = await this.requireOpen(client, vacancyId, eventId);
      const active = await this.repo.listActiveParticipants(client, eventId);
      const target = active.find((p) => p.id === participantId);
      if (!target) throw new EnquadreParticipantNotFoundError();
      if (columnOfStage(target.stage) !== 'CONVOKED') throw new EnquadreParticipantAlreadyMarkedError();
      await this.repo.releaseParticipant(client, participantId);
      await this.syncAttendees(client, ev, vacancyId);
    });
    logger.info({ vacancyId, eventId, participantId }, 'enquadre.participant_removed');
    return this.deps.readEvent(vacancyId, eventId, actor);
  }

  async cancelEvent(vacancyId: string, eventId: string, actor: EnquadreActor): Promise<EnquadreEventDetail> {
    await withActorContext(this.deps.db, async (client) => {
      const ev = await this.requireOpen(client, vacancyId, eventId);
      const active = await this.repo.listActiveParticipants(client, eventId);
      await this.repo.markEventCancelled(client, eventId, actor.uid);
      await this.repo.releaseAllCancelled(client, eventId);
      const text = cancelledNoteText(this.wallClock(ev));
      for (const p of active) {
        await ContactNoteRepository.insertSystemNote(client, { workerId: p.worker_id, jobPostingId: vacancyId, noteText: text });
      }
      await this.deleteInGoogle(ev, vacancyId);
    });
    logger.info({ vacancyId, eventId }, 'enquadre.event_cancelled');
    return this.deps.readEvent(vacancyId, eventId, actor);
  }

  /**
   * Marcar resultado = a MESMA mudança de estágio do Recrutamento (`moveApplicationStage`), com o motivo de salto dispensado
   * (spec 052, pergunta 4) e a origem `enquadre` só ao voltar a Convocados. Recusa do miolo vira o MESMO status/corpo do funil.
   */
  async moveParticipant(
    vacancyId: string,
    eventId: string,
    participantId: string,
    column: EnquadreColumnId,
    reason: string | undefined,
    actor: EnquadreActor,
  ): Promise<EnquadreEventDetail> {
    let stageEventId: string | null = null;
    await withActorContext(this.deps.db, async (client) => {
      await this.requireOpen(client, vacancyId, eventId);
      const active = await this.repo.listActiveParticipants(client, eventId);
      const p = active.find((x) => x.id === participantId);
      if (!p) throw new EnquadreParticipantNotFoundError();
      if (columnOfStage(p.stage) === column) return;
      await this.assertEligible(p, column);
      const moved = await moveApplicationStage(
        client,
        {
          workerId: p.worker_id,
          jobPostingId: vacancyId,
          encuadreId: p.encuadre_id,
          targetStage: STAGE_OF_COLUMN[column],
          actorUid: actor.uid,
          reasonCategory: reason,
        },
        { skipJumpReason: true, eventSource: column === 'CONVOKED' ? 'enquadre' : 'kanban' },
      );
      if (!moved.moved) throw refusalOf(moved.code, moved.reason);
      stageEventId = moved.eventId;
    });
    if (stageEventId) await publishStageEvent(this.deps.pubsub, stageEventId, 'EnquadreEventMutations:moveParticipant:publish');
    return this.deps.readEvent(vacancyId, eventId, actor);
  }

  /** Só depois do horário de fim. Carimba cada participação pelo estágio VIGENTE; NÃO muda estágio e NÃO fala com o Google. */
  async closeEvent(vacancyId: string, eventId: string, actor: EnquadreActor): Promise<EnquadreEventDetail> {
    await withActorContext(this.deps.db, async (client) => {
      const ev = await this.requireOpen(client, vacancyId, eventId);
      if (this.now().getTime() < ev.ends_at.getTime()) throw new EnquadreEventNotEndedError();
      const active = await this.repo.listActiveParticipants(client, eventId);
      const text = notMarkedNoteText(this.wallClock(ev));
      for (const p of active) {
        const outcome = outcomeOfStage(p.stage);
        await this.repo.closeParticipant(client, p.id, outcome);
        if (outcome === 'returned') {
          await ContactNoteRepository.insertSystemNote(client, { workerId: p.worker_id, jobPostingId: vacancyId, noteText: text });
        }
      }
      await this.repo.markEventClosed(client, eventId, actor.uid);
    });
    logger.info({ vacancyId, eventId }, 'enquadre.event_closed');
    return this.deps.readEvent(vacancyId, eventId, actor);
  }

  // ─── internos ──────────────────────────────────────────────────────────────

  /** Evento da vaga da rota, travado, e `open`. Vaga inexistente 404; evento de outra vaga 404; fechado/cancelado 409. */
  private async requireOpen(client: PoolClient, vacancyId: string, eventId: string): Promise<LockedEventRow> {
    const vacancy = await this.repo.findVacancy(client, vacancyId);
    if (!vacancy || !isAdmissionCountry(vacancy.country)) throw new EnquadreVacancyNotFoundError();
    const ev = await this.repo.lockEvent(client, vacancyId, eventId);
    if (!ev) throw new EnquadreEventNotFoundError();
    if (ev.status !== 'open') throw new EnquadreEventNotOpenError();
    return ev;
  }

  private calendarIdOf(ev: LockedEventRow): string {
    return resolveEnquadreCalendarId(ev.country as AdmissionCountry, this.deps.env);
  }

  /** `dd/mm hh:mm` no fuso do país do evento (o mesmo das anotações automáticas). */
  private wallClock(ev: LockedEventRow): string {
    const tz = getAdmissionCountryConfig(isAdmissionCountry(ev.country) ? ev.country : 'AR').timezone;
    return DateTime.fromJSDate(ev.starts_at, { zone: tz }).toFormat('dd/LL HH:mm');
  }

  /** Lista COMPLETA de convidados (entrevistadora + participantes ATIVOS agora) → Google. Falhou → erro 502 e ROLLBACK. */
  private async syncAttendees(client: PoolClient, ev: LockedEventRow, vacancyId: string): Promise<void> {
    const active = await this.repo.listActiveParticipants(client, ev.id);
    const emails = [ev.host_email, ...active.map((p) => (p.email ?? '').trim()).filter((e) => e.length > 0)];
    try {
      if (!ev.calendar_event_id) throw new Error('evento sem id no Google');
      await this.deps.calendar.setEventAttendees(this.calendarIdOf(ev), ev.calendar_event_id, this.deps.impersonateEmail, emails);
    } catch (err) {
      this.logCalendarFailure('enquadre.calendar_attendees_failed', vacancyId, ev.id, err);
      throw new EnquadreCalendarUpdateFailedError();
    }
  }

  /** Apaga no Google; evento já inexistente conta como sucesso. Outro erro → 502 e ROLLBACK. */
  private async deleteInGoogle(ev: LockedEventRow, vacancyId: string): Promise<void> {
    if (!ev.calendar_event_id) return;
    try {
      await this.deps.calendar.deleteEvent(this.calendarIdOf(ev), ev.calendar_event_id, this.deps.impersonateEmail);
    } catch (err) {
      if (isEventNotFound(err)) return;
      this.logCalendarFailure('enquadre.calendar_delete_failed', vacancyId, ev.id, err);
      throw new EnquadreCalendarUpdateFailedError();
    }
  }

  /** Só o nome da classe do erro: a mensagem do Google pode trazer e-mail de convidado. */
  private logCalendarFailure(event: string, vacancyId: string, eventId: string, err: unknown): void {
    logger.warn({ vacancyId, eventId, errorName: err instanceof Error ? err.name : 'unknown' }, event);
  }

  /**
   * A mesma recusa 403 do funil quando o prestador não pode ser movido. Spec 067 FR-24: para CONVOKED/SELECTED/QUICK_RESPONSE_TEAM
   * o limiar é o de APTO (`assertWorkerApto`: documentos obrigatórios validados); REJECTED fica no limiar de hoje
   * (`assertWorkerCanApply`) porque a operação precisa conseguir rejeitar quem perdeu a validação.
   */
  private async assertEligible(p: ActiveParticipantRow, column: EnquadreColumnId): Promise<void> {
    try {
      if (column === 'REJECTED') await assertWorkerCanApply(this.deps.db, p.worker_id);
      else await assertWorkerApto(this.deps.db, p.worker_id);
    } catch (err) {
      if (err instanceof WorkerNotEligibleError) {
        throw new EnquadreMoveRefusedError(err.status, {
          success: false,
          error: 'registration_incomplete',
          code: err.code,
          reason: err.reason,
          workerStatus: err.workerStatus,
        });
      }
      throw err;
    }
  }
}

/** Corpo 422 idêntico ao de `WJAFunnelController.moveEncuadre` para cada recusa do miolo. */
function refusalOf(code: 'COMPATIBLE_READ_ONLY' | 'MOVE_REASON_REQUIRED' | 'MOVE_REASON_INVALID', reason: string): EnquadreMoveRefusedError {
  const error = code === 'COMPATIBLE_READ_ONLY' ? 'compatible_read_only' : code === 'MOVE_REASON_REQUIRED' ? 'move_reason_required' : 'move_reason_invalid';
  return new EnquadreMoveRefusedError(422, { success: false, error, code, reason });
}
