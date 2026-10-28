import type { PoolClient } from 'pg';
import { CURRENT_WEEK_START_SQL, OPERATION_TIMEZONE } from '../domain/interviewSchedule';
import type { EnquadreEventStatus } from '../domain/enquadreEvent';

/**
 * EnquadreEventListRepository — SQL da lista GLOBAL de enquadres (spec 076, plano §5). Uma consulta, no `client` da transação
 * do chamador (`withActorContext`). Só leitura.
 *
 * - Semana atual: `CURRENT_WEEK_START_SQL` (a MESMA constante e o mesmo `NOW()` do indicador 21) — nunca outra definição.
 * - Filtro Desde/Hasta em dias de calendário de `OPERATION_TIMEZONE` (`::timestamp AT TIME ZONE`, hora de parede: independe
 *   do `TimeZone` da sessão).
 * - `enquadre_events` não tem RLS: o predicado `country = ANY($1)` vai SEMPRE.
 * - `hosts` = entrevistadores DISTINTOS de TODOS os eventos do escopo de país (ignora período/status/host/busca), até 200:
 *   o filtro de entrevistador nunca fica sem opções só porque o período está vazio.
 * - Convocados = participações sem `release_kind = 'removed'` (ativas + `closed` + `cancelled`).
 * - Nada de identidade: nem nome/e-mail do entrevistador (`host_email` não é lido), nem do paciente, nem do convocado.
 */

export interface EnquadreListFilters {
  /** Países do escopo do ator (nunca vazio). */
  countries: string[];
  /** `YYYY-MM-DD`; `null` = semana atual (resolvida no SQL). */
  from: string | null;
  to: string | null;
  statuses: EnquadreEventStatus[] | null;
  host: string | null;
  /** Padrão ILIKE já montado (`%ENC-AB12%`) ou `null`. */
  eventCodeLike: string | null;
  /** Padrão ILIKE dos dígitos do caso/vaga ou `null`. */
  digitsLike: string | null;
  ordinal: number | null;
  limit: number;
  offset: number;
}

export interface EnquadreListRow {
  id: string | null;
  job_posting_id: string | null;
  country: string | null;
  host_display_name: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  status: EnquadreEventStatus | null;
  import_status: string | null;
  blocked_reason: string | null;
  event_code: string | null;
  case_number: number | null;
  case_ordinal: number | null;
  convoked: number | null;
  total: number;
  convoked_total: number;
  range_from: string;
  range_to: string;
  hosts: string[];
}

const LIST_SQL = `
WITH win AS (
  SELECT COALESCE($2::date, (${CURRENT_WEEK_START_SQL} AT TIME ZONE '${OPERATION_TIMEZONE}')::date) AS d_from
), rng AS (
  SELECT d_from, COALESCE($3::date, d_from + 6) AS d_to FROM win
), base AS (
  SELECT ev.id, ev.job_posting_id, ev.country, ev.host_display_name, ev.starts_at, ev.ends_at, ev.status,
         ev.import_status, ev.blocked_reason, ev.event_code
    FROM enquadre_events ev, rng
   WHERE ev.country = ANY($1::text[])
     AND ev.starts_at >= (rng.d_from::timestamp AT TIME ZONE '${OPERATION_TIMEZONE}')
     AND ev.starts_at <  ((rng.d_to + 1)::timestamp AT TIME ZONE '${OPERATION_TIMEZONE}')
), f AS (
  SELECT b.*, jp.case_number, jp.case_ordinal
    FROM base b JOIN job_postings jp ON jp.id = b.job_posting_id
   WHERE ($4::text[] IS NULL OR b.status = ANY($4::text[]))
     AND ($5::text IS NULL OR b.host_display_name = $5)
     AND ($6::text IS NULL OR b.event_code ILIKE $6)
     AND ($7::text IS NULL OR jp.case_number::text ILIKE $7 OR jp.vacancy_number::text ILIKE $7)
     AND ($8::int IS NULL OR jp.case_ordinal = $8)
), fc AS (
  SELECT f.*, (SELECT count(*) FROM enquadre_event_participants p
                WHERE p.event_id = f.id AND p.release_kind IS DISTINCT FROM 'removed')::int AS convoked
    FROM f
), tot AS (SELECT count(*)::int AS total, COALESCE(sum(convoked), 0)::int AS convoked_total FROM fc)
SELECT tot.total, tot.convoked_total,
       to_char(rng.d_from, 'YYYY-MM-DD') AS range_from, to_char(rng.d_to, 'YYYY-MM-DD') AS range_to,
       (SELECT COALESCE(array_agg(h.name ORDER BY h.name), '{}') FROM (
          SELECT DISTINCT e.host_display_name AS name FROM enquadre_events e
           WHERE e.country = ANY($1::text[]) AND e.host_display_name IS NOT NULL
           ORDER BY e.host_display_name LIMIT 200) h) AS hosts,
       page.*
  FROM tot CROSS JOIN rng
  LEFT JOIN LATERAL (SELECT * FROM fc ORDER BY starts_at ASC, id ASC LIMIT $9::int OFFSET $10::int) page ON true`;

export class EnquadreEventListRepository {
  /** Sempre ≥ 1 linha: totais e período vêm mesmo com a página vazia (as colunas da página, então, são NULL). */
  async list(client: PoolClient, f: EnquadreListFilters): Promise<EnquadreListRow[]> {
    const res = await client.query<EnquadreListRow>(LIST_SQL, [
      f.countries,
      f.from,
      f.to,
      f.statuses,
      f.host,
      f.eventCodeLike,
      f.digitsLike,
      f.ordinal,
      f.limit,
      f.offset,
    ]);
    return res.rows;
  }
}
