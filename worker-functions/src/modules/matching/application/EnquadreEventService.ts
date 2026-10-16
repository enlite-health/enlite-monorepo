import { DateTime } from 'luxon';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { projectWorkerFields, type Decryptor } from '@modules/identity/permissions';
import { computeFreeSlots } from '../infrastructure/AdmissionCalendarService';
import type { InterviewHostRepository } from '../infrastructure/InterviewHostRepository';
import {
  EnquadreEventRepository,
  EVENT_CODE_INDEX,
  PARTICIPANT_LOCK_INDEX,
  type EventRow,
  type ParticipantRow,
  type VacancyRow,
} from '../infrastructure/EnquadreEventRepository';
import { getAdmissionCountryConfig, isAdmissionCountry, type AdmissionCountry } from '../domain/admissionCountries';
import { generateEnquadreCode } from '../domain/enquadreCode';
import {
  assertGuestsAllowed,
  parseGuestPolicy,
  resolveEnquadreCalendarId,
  type EnquadreEnv,
} from '../domain/enquadreCalendarConfig';
import {
  buildEnquadreEventTitle,
  enquadreEventPhase,
  eventCounters,
  participantColumn,
  type EnquadreColumnId,
  type EnquadreEventPhase,
  type EnquadreOutcomeCounts,
  type EnquadreParticipantOutcome,
} from '../domain/enquadreEvent';
import { pipelineOf, type EnquadrePipelineState } from '../domain/enquadrePipeline';
import type { AdmissionCalendarPort } from './ports/AdmissionCalendarPort';
import { TactiqLinkRequiredError, type TactiqLinkGate, type TactiqLinkState } from './ports/TactiqPorts';
import { isHostApt } from './admissionHostEligibility';
import { HostNotInRosterError, InvalidSlotError } from './AdmissionSchedulingErrors';
import { createEventWithRetry } from './admissionCalendarCreate';
import { readHostsBusy } from './admissionHostBusy';
import {
  EnquadreEventNotFoundError,
  EnquadreSlotInPastError,
  EnquadreVacancyNotFoundError,
  EnquadreWorkerEmailInvalidError,
  EnquadreWorkerNotAvailableError,
} from './EnquadreEventErrors';

/** Quantas vezes sorteia outro código ENC se o índice único acusar colisão (36^6 ≈ 2 bi: na prática 1). */
const MAX_CODE_ATTEMPTS = 5;

const EMAIL = z.string().email();
const WALL_CLOCK = "yyyy-LL-dd'T'HH:mm";
const FALLBACK_HOST_NAME = 'Entrevistadora';

// ─── Formas devolvidas: as MESMAS de `enlite-frontend/src/domain/entities/EnquadreEvent.ts` ───────────────────────────────

export type { EnquadrePipelineState };

export interface EnquadreEventListItem {
  id: string;
  startsAt: string;
  endsAt: string;
  hostName: string;
  /** País do evento (o da vaga): a tela formata data e hora no fuso dele. */
  country: AdmissionCountry;
  phase: EnquadreEventPhase;
  convokedCount: number;
  markedCount: number;
  outcome: EnquadreOutcomeCounts;
  meetLink: string | null;
  pipeline: EnquadrePipelineState | null;
}

export interface EnquadreParticipantView {
  id: string;
  workerId: string;
  workerName: string;
  occupation: string | null;
  column: EnquadreColumnId;
  outcome: EnquadreParticipantOutcome | null;
  rejectionReasonCategory: string | null;
}

export interface EnquadreEventDetail extends EnquadreEventListItem {
  participants: EnquadreParticipantView[];
  unmarkedCount: number;
}

export interface EnquadreWorkerOption {
  id: string;
  name: string;
  hasValidEmail: boolean;
}

export interface EnquadreAvailableWorkers {
  workers: EnquadreWorkerOption[];
  count: number;
}

export interface EnquadreHostOption {
  id: string;
  name: string;
  linkState: 'linked' | 'unlinked';
}

export interface CreateEnquadreEventInput {
  hostId: string;
  /** Hora de PAREDE `YYYY-MM-DDTHH:mm`, no fuso do país da vaga. */
  startsAt: string;
  durationMinutes: number;
  workerIds: string[];
}

/** Quem pede. `cells` = células da request (`cellsOfRequest`): decidem se o NOME do prestador sai (mesma projeção do kanban). */
export interface EnquadreViewer {
  cells: string[] | null;
}

export interface EnquadreActor extends EnquadreViewer {
  uid: string;
}

export interface EnquadreEventServiceDeps {
  db: Pool;
  calendar: AdmissionCalendarPort;
  hosts: Pick<InterviewHostRepository, 'listActiveWithIdByCountry'>;
  tactiq: TactiqLinkGate;
  /** KMS: decifra o nome do prestador. */
  decryptor: Decryptor;
  env: EnquadreEnv;
  impersonateEmail: string;
  repo?: EnquadreEventRepository;
  now?: () => Date;
  /** Esperas entre as tentativas de criar o evento no Google (teste passa `[]`). */
  calendarRetryDelaysMs?: readonly number[];
}

export function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === constraint;
}

/**
 * EnquadreEventService — o evento de enquadre (spec 052, Fase 2): LEITURA (lista, detalhe, prestadores disponíveis,
 * entrevistadoras, horários livres) e CRIAÇÃO. As mutações (acrescentar/tirar convocado, cancelar, mover, encerrar) moram em
 * `EnquadreEventMutations.ts`, sobre o mesmo repositório e a mesma forma de transação.
 *
 * Nada aqui fala com mensageria (WhatsApp/Cloud Tasks): o aviso ao prestador é o convite do próprio Google.
 * Log: só ids e contagens — nunca e-mail, nome ou telefone.
 */
export class EnquadreEventService {
  private readonly repo: EnquadreEventRepository;
  private readonly now: () => Date;

  constructor(private readonly deps: EnquadreEventServiceDeps) {
    this.repo = deps.repo ?? new EnquadreEventRepository();
    this.now = deps.now ?? (() => new Date());
  }

  // ─── leitura ───────────────────────────────────────────────────────────────

  async listEvents(vacancyId: string, viewer: EnquadreViewer = { cells: null }): Promise<EnquadreEventListItem[]> {
    return withActorContext(this.deps.db, async (client) => {
      await this.requireVacancy(client, vacancyId);
      const [events, participants] = await Promise.all([
        this.repo.listEvents(client, vacancyId),
        this.repo.listParticipants(client, vacancyId, null),
      ]);
      const now = this.now();
      const items = events.map((ev) => this.toDetail(ev, participants.filter((p) => p.event_id === ev.id), now, new Map(), viewer));
      return items.sort(byListOrder).map(({ participants: _p, unmarkedCount: _u, ...item }) => item);
    });
  }

  async getEvent(vacancyId: string, eventId: string, viewer: EnquadreViewer = { cells: null }): Promise<EnquadreEventDetail> {
    const loaded = await withActorContext(this.deps.db, async (client) => {
      await this.requireVacancy(client, vacancyId);
      const ev = await this.repo.findEvent(client, vacancyId, eventId);
      if (!ev) throw new EnquadreEventNotFoundError();
      return { ev, rows: await this.repo.listParticipants(client, vacancyId, eventId) };
    });
    const names = await this.namesOf(loaded.rows, viewer);
    return this.toDetail(loaded.ev, loaded.rows, this.now(), names, viewer);
  }

  async listAvailableWorkers(vacancyId: string, viewer: EnquadreViewer = { cells: null }): Promise<EnquadreAvailableWorkers> {
    const rows = await withActorContext(this.deps.db, async (client) => {
      await this.requireVacancy(client, vacancyId);
      return this.repo.listAvailableWorkers(client, vacancyId, null);
    });
    const workers: EnquadreWorkerOption[] = [];
    for (const r of rows) {
      workers.push({ id: r.id, name: await this.nameOf(r.id, r.first_name_encrypted, r.last_name_encrypted, viewer), hasValidEmail: hasValidEmail(r.email) });
    }
    workers.sort((a, b) => a.name.localeCompare(b.name));
    return { workers, count: workers.length };
  }

  /** Entrevistadoras ATIVAS do país da vaga. `linked` só quando o vínculo do Tactiq a torna apta (a mesma régua da admissão). */
  async listHosts(vacancyId: string): Promise<EnquadreHostOption[]> {
    const vacancy = await this.vacancyOf(vacancyId);
    const hosts = await this.deps.hosts.listActiveWithIdByCountry(vacancy.country, 'enquadre');
    const states = await this.linkStatesOf(hosts.map((h) => h.email));
    return hosts.map((h) => ({
      id: h.id,
      name: h.displayName ?? FALLBACK_HOST_NAME,
      linkState: isHostApt(states.get(h.email.toLowerCase())) ? 'linked' : 'unlinked',
    }));
  }

  /**
   * Horários de INÍCIO livres da entrevistadora no dia `date` (`YYYY-MM-DD`), em `HH:mm` de parede do país da vaga. Reusa a
   * leitura de ocupação (`readHostsBusy`) e a grade (`computeFreeSlots`) da admissão, com a duração como tamanho do horário.
   * São SUGESTÕES: a criação não recusa horário fora da grade. Agenda ilegível → lista vazia (fail-closed).
   */
  async listHostFreeSlots(vacancyId: string, hostId: string, date: string, durationMinutes: number): Promise<string[]> {
    const vacancy = await this.vacancyOf(vacancyId);
    const host = await this.findHost(vacancy.country, hostId);
    const cfg = getAdmissionCountryConfig(vacancy.country);
    const dayStart = DateTime.fromFormat(date, 'yyyy-LL-dd', { zone: cfg.timezone });
    if (!dayStart.isValid) throw new InvalidSlotError();
    const dayEnd = dayStart.endOf('day');
    const now = this.now();
    if (dayEnd.toMillis() <= now.getTime()) return [];

    const busy = await readHostsBusy(
      this.deps.calendar,
      this.deps.impersonateEmail,
      [host.email],
      dayStart.toISO() as string,
      dayEnd.toISO() as string,
      cfg.timezone,
      vacancy.country,
    );
    if (Object.keys(busy).length === 0) return [];

    const slots = computeFreeSlots({
      busyIntervalsByHost: busy,
      now: dayStart.toMillis() > now.getTime() ? dayStart.toJSDate() : now,
      timezone: cfg.timezone,
      holidays: cfg.holidays,
      businessHours: cfg.businessHours,
      slotMinutes: durationMinutes,
      minLeadMinutes: 0,
      horizonBusinessDays: 1,
    });
    return slots
      .map((s) => DateTime.fromISO(s.startISO, { zone: cfg.timezone }))
      .filter((s) => s.toFormat('yyyy-LL-dd') === date)
      .map((s) => s.toFormat('HH:mm'));
  }

  // ─── criação ───────────────────────────────────────────────────────────────

  /**
   * "Os dois ou nenhum": numa transação, `INSERT` do evento e das participações (a trava cai aqui, antes de qualquer convite) →
   * Google (id fixo, convidados = entrevistadora + TODOS os escolhidos, sem "modificar", lista oculta) → grava id e link →
   * `COMMIT`. Google falhou → o erro sobe e a transação faz `ROLLBACK`: nada fica gravado. `COMMIT` (ou o que vem depois do
   * Google) falhou com o evento já criado → apaga o evento pelo id fixo e o erro sobe.
   */
  async createEvent(vacancyId: string, input: CreateEnquadreEventInput, actor: EnquadreActor): Promise<EnquadreEventDetail> {
    const { db, calendar, impersonateEmail } = this.deps;
    // Caixa (não `let`): a atribuição acontece dentro do callback da transação e o `catch` precisa enxergá-la.
    const created: { value: { eventId: string; calendarId: string } | null } = { value: null };

    let eventId: string;
    try {
      eventId = await withActorContext(db, async (client) => {
        const vacancy = await this.requireVacancy(client, vacancyId);
        const country = vacancy.country as AdmissionCountry;
        const cfg = getAdmissionCountryConfig(country);

        const host = await this.findHost(country, input.hostId);
        await this.assertTactiqLinked(host.email);

        const start = DateTime.fromFormat(input.startsAt, WALL_CLOCK, { zone: cfg.timezone });
        if (!start.isValid) throw new InvalidSlotError();
        if (start.toMillis() < this.now().getTime()) throw new EnquadreSlotInPastError();
        const end = start.plus({ minutes: input.durationMinutes });

        const workerIds = [...new Set(input.workerIds)];
        const available = await this.repo.listAvailableWorkers(client, vacancyId, workerIds);
        if (available.length !== workerIds.length) throw new EnquadreWorkerNotAvailableError();
        const invalid = available.filter((w) => !hasValidEmail(w.email)).length;
        if (invalid > 0) throw new EnquadreWorkerEmailInvalidError(invalid);
        const guestEmails = available.map((w) => (w.email as string).trim());

        // Trava de canal real e agenda dedicada: ausente/malformada recusa ANTES de gravar ou convidar.
        assertGuestsAllowed(parseGuestPolicy(this.deps.env), guestEmails);
        const calendarId = resolveEnquadreCalendarId(country, this.deps.env);

        const { id, code } = await this.insertEventWithUniqueCode(client, {
          jobPostingId: vacancyId,
          hostEmail: host.email,
          hostDisplayName: host.displayName ?? FALLBACK_HOST_NAME,
          startsAt: start.toJSDate(),
          endsAt: end.toJSDate(),
          createdByUid: actor.uid,
        });
        try {
          await this.repo.insertParticipants(client, { eventId: id, jobPostingId: vacancyId, workerIds, addedByUid: actor.uid });
        } catch (err) {
          if (isUniqueViolation(err, PARTICIPANT_LOCK_INDEX)) throw new EnquadreWorkerNotAvailableError();
          throw err;
        }

        const google = await createEventWithRetry(
          calendar,
          {
            calendarId,
            impersonateEmail,
            summary: buildEnquadreEventTitle({ caseNumber: vacancy.case_number, eventCode: code }),
            description: '',
            startISO: start.toISO() as string,
            endISO: end.toISO() as string,
            timezone: cfg.timezone,
            coHostEmail: host.email,
            extraAttendeeEmails: guestEmails,
            guestsCanModify: false,
            guestsCanSeeOtherGuests: false,
            guestsCanInviteOthers: false,
          },
          id,
          this.deps.calendarRetryDelaysMs,
        );
        created.value = { eventId: google.eventId, calendarId };
        await this.repo.attachCalendarRefs(client, id, google.eventId, google.meetLink);
        return id;
      });
    } catch (err) {
      if (created.value) await this.deleteQuietly(created.value, vacancyId);
      throw err;
    }
    logger.info({ vacancyId, eventId }, 'enquadre.event_created');
    return this.getEvent(vacancyId, eventId, actor);
  }

  // ─── internos ──────────────────────────────────────────────────────────────

  private async insertEventWithUniqueCode(
    client: PoolClient,
    base: { jobPostingId: string; hostEmail: string; hostDisplayName: string; startsAt: Date; endsAt: Date; createdByUid: string },
  ): Promise<{ id: string; code: string }> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const code = generateEnquadreCode();
      await client.query('SAVEPOINT enquadre_code');
      try {
        const id = await this.repo.insertEvent(client, { ...base, eventCode: code });
        await client.query('RELEASE SAVEPOINT enquadre_code');
        return { id, code };
      } catch (err) {
        if (!isUniqueViolation(err, EVENT_CODE_INDEX)) throw err;
        await client.query('ROLLBACK TO SAVEPOINT enquadre_code');
      }
    }
    throw new Error('[EnquadreEventService] não gerou um código ENC único');
  }

  /** Compensação best-effort: o evento do Google não pode sobrar sem linha no banco. Log só com ids. */
  private async deleteQuietly(created: { eventId: string; calendarId: string }, vacancyId: string): Promise<void> {
    try {
      await this.deps.calendar.deleteEvent(created.calendarId, created.eventId, this.deps.impersonateEmail);
    } catch {
      logger.warn({ vacancyId, calendarEventId: created.eventId }, 'enquadre.calendar_cleanup_failed');
    }
  }

  private async requireVacancy(client: PoolClient, vacancyId: string): Promise<VacancyRow> {
    const vacancy = await this.repo.findVacancy(client, vacancyId);
    if (!vacancy || !isAdmissionCountry(vacancy.country)) throw new EnquadreVacancyNotFoundError();
    return vacancy;
  }

  private async vacancyOf(vacancyId: string): Promise<VacancyRow & { country: AdmissionCountry }> {
    const vacancy = await withActorContext(this.deps.db, (client) => this.requireVacancy(client, vacancyId));
    return { ...vacancy, country: vacancy.country as AdmissionCountry };
  }

  private async findHost(country: AdmissionCountry, hostId: string) {
    const roster = await this.deps.hosts.listActiveWithIdByCountry(country, 'enquadre');
    const host = roster.find((h) => h.id === hostId);
    if (!host) throw new HostNotInRosterError();
    return host;
  }

  private async linkStatesOf(emails: string[]): Promise<Map<string, TactiqLinkState>> {
    return emails.length > 0 ? this.deps.tactiq.statesFor(emails) : new Map();
  }

  /** A trava do vínculo do Tactiq é a da admissão: mesma régua (`isHostApt`), mesmo erro (409 `TACTIQ_LINK_REQUIRED`). */
  private async assertTactiqLinked(hostEmail: string): Promise<void> {
    const states = await this.linkStatesOf([hostEmail]);
    const state = states.get(hostEmail.toLowerCase()) ?? 'missing';
    if (!isHostApt(state)) throw new TactiqLinkRequiredError(state);
  }

  private async nameOf(workerId: string, first: string | null, last: string | null, viewer: EnquadreViewer): Promise<string> {
    const visible = await projectWorkerFields(viewer.cells, { firstNameEncrypted: first, lastNameEncrypted: last }, this.deps.decryptor);
    return visible.name ?? `Worker #${workerId.slice(-8)}`;
  }

  private async namesOf(rows: ParticipantRow[], viewer: EnquadreViewer): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const r of rows) names.set(r.id, await this.nameOf(r.worker_id, r.first_name_encrypted, r.last_name_encrypted, viewer));
    return names;
  }

  private toDetail(ev: EventRow, rows: ParticipantRow[], now: Date, names: Map<string, string>, viewer: EnquadreViewer): EnquadreEventDetail {
    const participants: EnquadreParticipantView[] = rows.map((r) => ({
      id: r.id,
      workerId: r.worker_id,
      workerName: names.get(r.id) ?? '',
      occupation: r.occupation_raw,
      column: participantColumn({ eventStatus: ev.status, currentStage: r.stage, outcome: r.outcome }),
      outcome: r.outcome,
      rejectionReasonCategory: r.rejection_reason_category,
    }));
    const counters = eventCounters(participants);
    const country: AdmissionCountry = isAdmissionCountry(ev.country) ? ev.country : 'AR';
    const tz = getAdmissionCountryConfig(country).timezone;
    return {
      id: ev.id,
      startsAt: inZone(ev.starts_at, tz),
      endsAt: inZone(ev.ends_at, tz),
      hostName: ev.host_display_name,
      country,
      phase: enquadreEventPhase(ev.status, ev.ends_at, now),
      convokedCount: counters.convokedCount,
      markedCount: counters.markedCount,
      outcome: counters.outcome,
      meetLink: ev.status === 'open' ? ev.meet_link : null,
      pipeline: pipelineOf(
        {
          importStatus: ev.import_status,
          blockedReason: ev.blocked_reason,
          hasSummary: ev.has_summary,
          unidentifiedCount: rows.filter((r) => r.attendance === 'unidentified').length,
        },
        viewer.cells,
      ),
      participants,
      unmarkedCount: counters.unmarkedCount,
    };
  }
}

export function hasValidEmail(email: string | null): boolean {
  return typeof email === 'string' && EMAIL.safeParse(email.trim()).success;
}

function inZone(d: Date, zone: string): string {
  return DateTime.fromJSDate(d, { zone }).toISO({ suppressMilliseconds: true }) as string;
}

/** Próximos (abertos) em cima, por início crescente; encerrados e cancelados embaixo, o mais recente primeiro. */
function byListOrder(a: EnquadreEventListItem, b: EnquadreEventListItem): number {
  const aOpen = a.phase === 'scheduled' || a.phase === 'pending_close';
  const bOpen = b.phase === 'scheduled' || b.phase === 'pending_close';
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  const diff = Date.parse(a.startsAt) - Date.parse(b.startsAt);
  return aOpen ? diff : -diff;
}
