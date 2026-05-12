/**
 * vacancyListHelpers
 *
 * Presentation-layer helpers for VacanciesController.
 * Extracted to keep VacanciesController within the 400-line limit.
 */

import {
  POSTULATED_STAGES,
  PRE_SELECTED_STAGES,
  toSqlInList,
} from '../../domain/applicationFunnelStages';

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

const POSTULATED_SQL = toSqlInList(POSTULATED_STAGES);
const PRE_SELECTED_SQL = toSqlInList(PRE_SELECTED_STAGES);

const LIST_VACANCIES_BASE = `
  SELECT
    jp.id,
    jp.case_number,
    jp.vacancy_number,
    jp.title,
    jp.status,
    jp.priority,
    p.zone_neighborhood as patient_zone,
    jp.search_start_date,
    jp.created_at,
    jp.updated_at,
    get_applicant_count(jp.id) AS current_applicants,
    jp.max_applicants,
    p.first_name as patient_first_name,
    p.last_name as patient_last_name,
    CASE
      WHEN jp.search_start_date IS NOT NULL
      THEN EXTRACT(DAY FROM NOW() - jp.search_start_date)::INTEGER
      ELSE 0
    END as dias_aberto,
    (SELECT COUNT(*) FROM worker_job_applications wja
      WHERE wja.job_posting_id = jp.id) as convidados,
    (SELECT COUNT(*) FROM worker_job_applications wja
      WHERE wja.job_posting_id = jp.id
        AND wja.application_funnel_stage IN (${POSTULATED_SQL})) as postulados,
    (SELECT COUNT(*) FROM worker_job_applications wja
      WHERE wja.job_posting_id = jp.id
        AND wja.application_funnel_stage IN (${PRE_SELECTED_SQL})) as selecionados,
    CASE
      WHEN jp.providers_needed IS NOT NULL AND jp.providers_needed ~ '^[0-9]+$'
      THEN GREATEST(
        jp.providers_needed::INTEGER - (
          SELECT COUNT(*) FROM worker_job_applications wja
          WHERE wja.job_posting_id = jp.id
            AND wja.application_funnel_stage IN (${PRE_SELECTED_SQL})
        ),
        0
      )
      ELSE NULL
    END as faltantes
  FROM job_postings jp
  LEFT JOIN patients p ON jp.patient_id = p.id
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

export interface ListVacanciesFilters {
  search?: unknown;
  status?: unknown;
  priority?: unknown;
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
  priority: string | null;
  dias_aberto: number | null;
  convidados: number | string | null;
  postulados: number | string | null;
  selecionados: number | string | null;
  faltantes: number | string | null;
}

export function mapVacancyListRow(row: VacancyListRow) {
  return {
    id: row.id,
    initials: getInitials(row.patient_first_name, row.patient_last_name),
    name: `${row.patient_first_name || ''} ${row.patient_last_name || ''}`.trim(),
    email: '',
    caso: `Caso ${row.case_number}-${row.vacancy_number}`,
    vacancyNumber: row.vacancy_number,
    status: mapStatus(row.status),
    statusRaw: row.status,
    priority: row.priority,
    diasAberto: row.dias_aberto?.toString().padStart(2, '0') ?? '00',
    convidados: row.convidados?.toString().padStart(2, '0') ?? '00',
    postulados: row.postulados?.toString().padStart(2, '0') ?? '00',
    selecionados: row.selecionados?.toString().padStart(2, '0') ?? '00',
    faltantes: row.faltantes != null ? row.faltantes.toString().padStart(2, '0') : null,
  };
}
