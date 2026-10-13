import type { PoolClient } from 'pg';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { COMPLETED_COLUMN_STAGES } from '../domain/kanbanColumn';
import type { EnquadreEventStatus, EnquadreParticipantOutcome } from '../domain/enquadreEvent';

/**
 * EnquadreEventRepository — SQL do evento de enquadre (spec 052, migration 518). Todo método recebe o `client` da TRANSAÇÃO do
 * chamador (`withActorContext`): é o que carimba `app.current_uid` e o contexto de país (RLS de `patients`). NENHUM DELETE:
 * tirar convocado e cancelar são UPDATE de carimbo (a 518 revoga DELETE). As escritas do estágio da candidatura NÃO moram
 * aqui: só `moveApplicationStage` escreve `application_funnel_stage`.
 */

export interface VacancyRow {
  id: string;
  country: string;
  case_number: number | null;
  patient_last_name: string | null;
}

export interface EventRow {
  id: string;
  country: string;
  host_display_name: string;
  starts_at: Date;
  ends_at: Date;
  status: EnquadreEventStatus;
  meet_link: string | null;
  import_status: string | null;
}

export interface ParticipantRow {
  id: string;
  event_id: string;
  worker_id: string;
  release_kind: 'closed' | 'cancelled' | null;
  outcome: EnquadreParticipantOutcome | null;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  stage: string | null;
  occupation_raw: string | null;
  rejection_reason_category: string | null;
}

/** Evento relido COM TRAVA (`FOR UPDATE`) para mutar: traz o que o Google e o carimbo precisam. */
export interface LockedEventRow extends EventRow {
  host_email: string;
  calendar_event_id: string | null;
}

/** Participação ATIVA (`released_at IS NULL`) com o que as mutações precisam: e-mail (convite), estágio vigente e o encuadre mais recente. */
export interface ActiveParticipantRow {
  id: string;
  worker_id: string;
  email: string | null;
  stage: string | null;
  encuadre_id: string | null;
}

export interface AvailableWorkerRow {
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  email: string | null;
}

export interface InsertEventInput {
  jobPostingId: string;
  hostEmail: string;
  hostDisplayName: string;
  startsAt: Date;
  endsAt: Date;
  eventCode: string;
  createdByUid: string;
}

export const EVENT_CODE_INDEX = 'uq_enquadre_events_code';
export const PARTICIPANT_LOCK_INDEX = 'uq_enquadre_participant_um_aberto';

export class EnquadreEventRepository {
  /** Vaga + nº do caso + sobrenome do paciente. `patients` tem RLS de país: o `client` precisa vir de `withActorContext`. */
  async findVacancy(client: PoolClient, vacancyId: string): Promise<VacancyRow | null> {
    const res = await client.query<VacancyRow>(
      `SELECT jp.id, jp.country, jp.case_number, pt.last_name AS patient_last_name
         FROM job_postings jp
         LEFT JOIN patients pt ON pt.id = jp.patient_id AND pt.deleted_at IS NULL
        WHERE jp.id = $1`,
      [vacancyId],
    );
    return res.rows[0] ?? null;
  }

  async listEvents(client: PoolClient, vacancyId: string): Promise<EventRow[]> {
    const res = await client.query<EventRow>(
      `SELECT id, country, host_display_name, starts_at, ends_at, status, meet_link, import_status
         FROM enquadre_events
        WHERE job_posting_id = $1`,
      [vacancyId],
    );
    return res.rows;
  }

  async findEvent(client: PoolClient, vacancyId: string, eventId: string): Promise<EventRow | null> {
    const res = await client.query<EventRow>(
      `SELECT id, country, host_display_name, starts_at, ends_at, status, meet_link, import_status
         FROM enquadre_events
        WHERE job_posting_id = $1 AND id = $2`,
      [vacancyId, eventId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Participações que o evento MOSTRA: as ativas, as carimbadas no encerramento e as do evento cancelado. As `removed`
   * (tiradas com o evento aberto) não aparecem. Um evento (`eventId`) ou todos os da vaga.
   */
  async listParticipants(client: PoolClient, vacancyId: string, eventId: string | null): Promise<ParticipantRow[]> {
    const res = await client.query<ParticipantRow>(
      `SELECT p.id, p.event_id, p.worker_id, p.release_kind, p.outcome,
              w.first_name_encrypted, w.last_name_encrypted,
              wja.application_funnel_stage AS stage,
              e.occupation_raw, e.rejection_reason_category
         FROM enquadre_event_participants p
         JOIN workers w ON w.id = p.worker_id
         LEFT JOIN worker_job_applications wja
                ON wja.worker_id = p.worker_id AND wja.job_posting_id = p.job_posting_id
         LEFT JOIN LATERAL (
               SELECT occupation_raw, rejection_reason_category
                 FROM encuadres
                WHERE worker_id = p.worker_id AND job_posting_id = p.job_posting_id
                ORDER BY created_at DESC
                LIMIT 1
              ) e ON true
        WHERE p.job_posting_id = $1
          AND ($2::uuid IS NULL OR p.event_id = $2::uuid)
          AND (p.release_kind IS NULL OR p.release_kind IN ('closed', 'cancelled'))
        ORDER BY p.created_at ASC, p.id ASC`,
      [vacancyId, eventId],
    );
    return res.rows;
  }

  /**
   * Quem pode ser convocado: candidatura da vaga na coluna Completado (os estágios que o quadro B colapsa, `kanbanColumn.ts`)
   * E sem participação ativa (`released_at IS NULL`) na vaga. `onlyWorkerIds` restringe a esses ids (validação da criação).
   */
  async listAvailableWorkers(client: PoolClient, vacancyId: string, onlyWorkerIds: readonly string[] | null): Promise<AvailableWorkerRow[]> {
    const res = await client.query<AvailableWorkerRow>(
      `SELECT w.id, w.first_name_encrypted, w.last_name_encrypted, w.email
         FROM worker_job_applications wja
         JOIN workers w ON w.id = wja.worker_id
        WHERE wja.job_posting_id = $1
          AND wja.application_funnel_stage = ANY($2::text[])
          AND ${excludeDisabledWorkersSql('w')}
          AND NOT EXISTS (
                SELECT 1 FROM enquadre_event_participants p
                 WHERE p.job_posting_id = wja.job_posting_id
                   AND p.worker_id = wja.worker_id
                   AND p.released_at IS NULL)
          AND ($3::uuid[] IS NULL OR w.id = ANY($3::uuid[]))
        ORDER BY wja.created_at ASC, w.id ASC`,
      [vacancyId, COMPLETED_COLUMN_STAGES, onlyWorkerIds ? [...onlyWorkerIds] : null],
    );
    return res.rows;
  }

  /** Insere o evento aberto. `country` vem de `job_postings` por trigger. Violação do índice do código sobe como `23505`. */
  async insertEvent(client: PoolClient, input: InsertEventInput): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO enquadre_events
         (job_posting_id, host_email, host_display_name, starts_at, ends_at, event_code, created_by_uid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.jobPostingId, input.hostEmail, input.hostDisplayName, input.startsAt, input.endsAt, input.eventCode, input.createdByUid],
    );
    return res.rows[0].id;
  }

  /** Participações ativas. A trava (`uq_enquadre_participant_um_aberto`) cai aqui, ANTES de qualquer convite sair. */
  async insertParticipants(
    client: PoolClient,
    input: { eventId: string; jobPostingId: string; workerIds: readonly string[]; addedByUid: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO enquadre_event_participants (event_id, job_posting_id, worker_id, added_by_uid)
       SELECT $1::uuid, $2::uuid, w, $4 FROM unnest($3::uuid[]) AS w`,
      [input.eventId, input.jobPostingId, [...input.workerIds], input.addedByUid],
    );
  }

  async attachCalendarRefs(client: PoolClient, eventId: string, calendarEventId: string, meetLink: string): Promise<void> {
    await client.query(`UPDATE enquadre_events SET calendar_event_id = $2, meet_link = $3 WHERE id = $1`, [eventId, calendarEventId, meetLink]);
  }

  // ─── mutações (T-30c) ──────────────────────────────────────────────────────

  /** O evento da vaga, TRAVADO até o fim da transação: duas mutações no mesmo evento se enfileiram. */
  async lockEvent(client: PoolClient, vacancyId: string, eventId: string): Promise<LockedEventRow | null> {
    const res = await client.query<LockedEventRow>(
      `SELECT id, country, host_display_name, host_email, calendar_event_id, starts_at, ends_at, status, meet_link, import_status
         FROM enquadre_events
        WHERE job_posting_id = $1 AND id = $2
          FOR UPDATE`,
      [vacancyId, eventId],
    );
    return res.rows[0] ?? null;
  }

  async listActiveParticipants(client: PoolClient, eventId: string): Promise<ActiveParticipantRow[]> {
    const res = await client.query<ActiveParticipantRow>(
      `SELECT p.id, p.worker_id, w.email,
              wja.application_funnel_stage AS stage,
              (SELECT e.id FROM encuadres e
                WHERE e.worker_id = p.worker_id AND e.job_posting_id = p.job_posting_id
                ORDER BY e.created_at DESC LIMIT 1) AS encuadre_id
         FROM enquadre_event_participants p
         JOIN workers w ON w.id = p.worker_id
         LEFT JOIN worker_job_applications wja
                ON wja.worker_id = p.worker_id AND wja.job_posting_id = p.job_posting_id
        WHERE p.event_id = $1 AND p.released_at IS NULL
        ORDER BY p.created_at ASC, p.id ASC`,
      [eventId],
    );
    return res.rows;
  }

  /** Tirar convocado: carimba a saída (`removed`), não apaga. */
  async releaseParticipant(client: PoolClient, participantId: string): Promise<void> {
    await client.query(
      `UPDATE enquadre_event_participants SET released_at = now(), release_kind = 'removed' WHERE id = $1 AND released_at IS NULL`,
      [participantId],
    );
  }

  /** Cancelar o evento: libera TODAS as participações ativas (`cancelled`). */
  async releaseAllCancelled(client: PoolClient, eventId: string): Promise<void> {
    await client.query(
      `UPDATE enquadre_event_participants SET released_at = now(), release_kind = 'cancelled' WHERE event_id = $1 AND released_at IS NULL`,
      [eventId],
    );
  }

  async markEventCancelled(client: PoolClient, eventId: string, uid: string): Promise<void> {
    await client.query(
      `UPDATE enquadre_events SET status = 'cancelled', cancelled_at = now(), cancelled_by_uid = $2 WHERE id = $1`,
      [eventId, uid],
    );
  }

  /** Encerrar: carimba a participação ativa com o resultado (`closed` + `outcome`, que o CHECK da 518 exige juntos). */
  async closeParticipant(client: PoolClient, participantId: string, outcome: EnquadreParticipantOutcome): Promise<void> {
    await client.query(
      `UPDATE enquadre_event_participants SET released_at = now(), release_kind = 'closed', outcome = $2 WHERE id = $1 AND released_at IS NULL`,
      [participantId, outcome],
    );
  }

  async markEventClosed(client: PoolClient, eventId: string, uid: string): Promise<void> {
    await client.query(`UPDATE enquadre_events SET status = 'closed', closed_at = now(), closed_by_uid = $2 WHERE id = $1`, [eventId, uid]);
  }
}
