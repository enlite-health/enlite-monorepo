/**
 * vacancyListHelpers
 *
 * Presentation-layer helpers for VacanciesController.
 * Extracted to keep VacanciesController within the 400-line limit.
 */

import {
  CONFIRMED_KANBAN_STAGES,
  POSTULATED_STAGES,
  SELECTED_KANBAN_STAGES,
  toSqlInList,
} from '../../domain/applicationFunnelStages';
import {
  buildScheduleFilter,
  parseDaysCsv,
  parseTimeHHMM,
} from './vacancyScheduleFilter';
import { workerNotDisabledSql } from '@shared/database/activeWorkerFilter';
import { INICIAIS_REDIGIDAS, patientNameIsRedacted } from '../../application/patientInVacancyProjection';

// ── Display mappers ────────────────────────────────────────────────────────────

export function getInitials(firstName: string | null, lastName: string | null): string {
  const first = firstName?.charAt(0)?.toUpperCase() || '';
  const last = lastName?.charAt(0)?.toUpperCase() || '';
  return first + last || 'XX';
}

export function mapStatus(status: string | null): string {
  const statusMap: Record<string, string> = {
    'SEARCHING':             'Buscando AT',
    'SEARCHING_REPLACEMENT': 'Buscando Sustituto',
    'RAPID_RESPONSE':        'Respuesta Rápida',
    'PENDING_ACTIVATION':    'Esperando Activación',
    'ACTIVE':                'Activo',
    'ON_HOLD':               'En Espera',
    'SUSPENDED':             'Suspendido',
    'CLOSED':                'Cerrado',
  };
  return statusMap[status ?? ''] ?? 'Desconocido';
}

// ── listVacancies query builder ────────────────────────────────────────────────

/** Recorte "não conta quem deu baixa" — mesmo predicado do kanban da vaga. */
const WORKER_ACTIVE_SQL = workerNotDisabledSql('wja.worker_id');

const POSTULATED_SQL = toSqlInList(POSTULATED_STAGES);
const CONFIRMED_KANBAN_SQL = toSqlInList(CONFIRMED_KANBAN_STAGES);
const SELECTED_KANBAN_SQL = toSqlInList(SELECTED_KANBAN_STAGES);

const LIST_VACANCIES_BASE = `
  SELECT
    jp.id,
    jp.case_number,
    jp.vacancy_number,
    jp.title,
    jp.status,
    jp.is_draft,
    jp.priority,
    p.zone_neighborhood as patient_zone,
    jp.search_start_date,
    jp.created_at,
    jp.updated_at,
    -- Era get_applicant_count(jp.id) (função STABLE no banco, sem recorte de
    -- status). Virou subselect para excluir quem deu baixa na conta e bater com
    -- os contadores abaixo e com o kanban da vaga.
    (SELECT COUNT(*) FROM worker_job_applications wja
      WHERE wja.job_posting_id = jp.id
        AND ${WORKER_ACTIVE_SQL}) AS current_applicants,
    jp.max_applicants,
    p.first_name as patient_first_name,
    p.last_name as patient_last_name,
    CASE
      WHEN jp.search_start_date IS NOT NULL
      THEN EXTRACT(DAY FROM NOW() - jp.search_start_date)::INTEGER
      ELSE 0
    END as dias_aberto,
    (SELECT COUNT(*) FROM worker_job_applications wja
      WHERE wja.job_posting_id = jp.id
        AND ${WORKER_ACTIVE_SQL}) as convidados,
    (SELECT COUNT(*) FROM worker_job_applications wja
      WHERE wja.job_posting_id = jp.id
        AND wja.application_funnel_stage IN (${POSTULATED_SQL})
        AND ${WORKER_ACTIVE_SQL}) as postulados,
    (SELECT COUNT(*) FROM worker_job_applications wja
      WHERE wja.job_posting_id = jp.id
        AND wja.application_funnel_stage IN (${CONFIRMED_KANBAN_SQL})
        AND ${WORKER_ACTIVE_SQL}) as confirmados,
    (SELECT COUNT(*) FROM worker_job_applications wja
      WHERE wja.job_posting_id = jp.id
        AND wja.application_funnel_stage IN (${SELECTED_KANBAN_SQL})
        AND ${WORKER_ACTIVE_SQL}) as selecionados,
    CASE
      WHEN jp.providers_needed IS NOT NULL AND jp.providers_needed ~ '^[0-9]+$'
      THEN GREATEST(
        -- quem deu baixa não ocupa a vaga: a posição volta a faltar
        jp.providers_needed::INTEGER - (
          SELECT COUNT(*) FROM worker_job_applications wja
          WHERE wja.job_posting_id = jp.id
            AND wja.application_funnel_stage IN (${SELECTED_KANBAN_SQL})
            AND ${WORKER_ACTIVE_SQL}
        ),
        0
      )
      ELSE NULL
    END as faltantes
  FROM job_postings jp
  LEFT JOIN patients p ON jp.patient_id = p.id
  LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
  WHERE jp.case_number IS NOT NULL
    AND jp.deleted_at IS NULL
`;

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'ON_HOLD',
  'SUSPENDED',
  'CLOSED',
]);

const VALID_PRIORITIES: ReadonlySet<string> = new Set(['URGENT', 'HIGH', 'NORMAL', 'LOW']);

/** Values accepted for the workerType filter (maps to required_professions column). */
const VALID_WORKER_TYPES: ReadonlySet<string> = new Set(['AT', 'CAREGIVER']);

/** Values accepted for the requiredSex filter. */
const VALID_REQUIRED_SEX: ReadonlySet<string> = new Set(['F', 'M', 'BOTH']);

export interface ListVacanciesFilters {
  search?: unknown;
  status?: unknown;
  priority?: unknown;
  /** Filter by required_professions: 'AT' | 'CAREGIVER' */
  workerType?: unknown;
  /** Filter by patient_addresses.state (ILIKE exact value). */
  state?: unknown;
  /** Filter by patient_addresses.city (ILIKE exact value). */
  city?: unknown;
  /** Filter by required_sex: 'F' | 'M' | 'BOTH'. */
  requiredSex?: unknown;
  /**
   * CSV of day-of-week ints (0=Sun … 6=Sat). Vacancy must cover ALL listed days.
   * Example: "1,2,3"
   */
  days?: unknown;
  /** Start of time window "HH:MM". Both timeFrom AND timeTo must be provided. */
  timeFrom?: unknown;
  /** End of time window "HH:MM". Both timeFrom AND timeTo must be provided. */
  timeTo?: unknown;
  limit: string;
  offset: string;
}

export interface ListVacanciesQuery {
  baseQuery: string;
  params: unknown[];
  paramIndex: number;
}

export function buildListVacanciesQuery(filters: ListVacanciesFilters): ListVacanciesQuery {
  let baseQuery = LIST_VACANCIES_BASE;
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.search) {
    baseQuery += ` AND (
      p.first_name ILIKE $${paramIndex}
      OR p.last_name ILIKE $${paramIndex}
      OR jp.case_number::TEXT ILIKE $${paramIndex}
      OR jp.vacancy_number::TEXT ILIKE $${paramIndex}
      OR jp.title ILIKE $${paramIndex}
    )`;
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  if (typeof filters.status === 'string' && VALID_STATUSES.has(filters.status)) {
    baseQuery += ` AND jp.status = $${paramIndex}`;
    params.push(filters.status);
    paramIndex++;
  }

  if (typeof filters.priority === 'string' && VALID_PRIORITIES.has(filters.priority)) {
    baseQuery += ` AND jp.priority = $${paramIndex}`;
    params.push(filters.priority);
    paramIndex++;
  }

  if (typeof filters.workerType === 'string' && VALID_WORKER_TYPES.has(filters.workerType)) {
    baseQuery += ` AND $${paramIndex} = ANY(jp.required_professions)`;
    params.push(filters.workerType);
    paramIndex++;
  }

  if (typeof filters.state === 'string' && filters.state.trim() !== '') {
    baseQuery += ` AND pa.state ILIKE $${paramIndex}`;
    params.push(filters.state.trim());
    paramIndex++;
  }

  if (typeof filters.city === 'string' && filters.city.trim() !== '') {
    baseQuery += ` AND pa.city ILIKE $${paramIndex}`;
    params.push(filters.city.trim());
    paramIndex++;
  }

  if (typeof filters.requiredSex === 'string' && VALID_REQUIRED_SEX.has(filters.requiredSex)) {
    baseQuery += ` AND jp.required_sex = $${paramIndex}`;
    params.push(filters.requiredSex);
    paramIndex++;
  }

  // Schedule filter: days CSV + optional HH:MM window.
  const days     = parseDaysCsv(filters.days);
  const timeFrom = parseTimeHHMM(filters.timeFrom);
  const timeTo   = parseTimeHHMM(filters.timeTo);

  const scheduleResult = buildScheduleFilter({ days, timeFrom, timeTo }, paramIndex);
  if (scheduleResult.sql) {
    baseQuery += scheduleResult.sql;
    params.push(...scheduleResult.params);
    paramIndex = scheduleResult.nextParamIndex;
  }

  return { baseQuery, params, paramIndex };
}

// ── Row mapper ─────────────────────────────────────────────────────────────────

export interface VacancyListRow {
  id: string;
  patient_first_name: string | null;
  patient_last_name: string | null;
  case_number: number;
  vacancy_number: number;
  status: string | null;
  is_draft: boolean | null;
  priority: string | null;
  dias_aberto: number | null;
  convidados: number | string | null;
  postulados: number | string | null;
  confirmados: number | string | null;
  selecionados: number | string | null;
  faltantes: number | string | null;
}

export function mapVacancyListRow(row: VacancyListRow) {
  // D286 fase 2: a linha já chegou projetada (`projectPatientInVacancy`); com o nome redigido
  // as iniciais não podem ser as do rótulo.
  const redigido = patientNameIsRedacted(row);
  return {
    id: row.id,
    initials: redigido ? INICIAIS_REDIGIDAS : getInitials(row.patient_first_name, row.patient_last_name),
    name: `${row.patient_first_name || ''} ${row.patient_last_name || ''}`.trim(),
    email: '',
    caso: `Caso ${row.case_number}-${row.vacancy_number}`,
    vacancyNumber: row.vacancy_number,
    status: mapStatus(row.status),
    statusRaw: row.status,
    is_draft: row.is_draft === true,
    priority: row.priority,
    diasAberto: row.dias_aberto?.toString().padStart(2, '0') ?? '00',
    convidados: row.convidados?.toString().padStart(2, '0') ?? '00',
    postulados: row.postulados?.toString().padStart(2, '0') ?? '00',
    confirmados: row.confirmados?.toString().padStart(2, '0') ?? '00',
    selecionados: row.selecionados?.toString().padStart(2, '0') ?? '00',
    faltantes: row.faltantes != null ? row.faltantes.toString().padStart(2, '0') : null,
  };
}
