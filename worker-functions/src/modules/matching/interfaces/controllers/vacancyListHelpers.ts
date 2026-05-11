/**
 * vacancyListHelpers
 *
 * Presentation-layer helpers for VacanciesController.
 * Extracted to keep VacanciesController within the 400-line limit.
 */

// ── Display mappers ────────────────────────────────────────────────────────────

export function getInitials(firstName: string | null, lastName: string | null): string {
  const first = firstName?.charAt(0)?.toUpperCase() || '';
  const last = lastName?.charAt(0)?.toUpperCase() || '';
  return first + last || 'XX';
}

export function mapStatus(status: string | null): string {
  const statusMap: Record<string, string> = {
    'SEARCHING':             'Buscando AT',
    'SEARCHING_REPLACEMENT': 'Buscando Substituto',
    'RAPID_RESPONSE':        'Resposta Rápida',
    'PENDING_ACTIVATION':    'Aguardando Ativação',
    'ACTIVE':                'Ativo',
    'SUSPENDED':             'Suspenso',
    'CLOSED':                'Encerrado',
  };
  return statusMap[status ?? ''] ?? 'Desconhecido';
}

export function mapDependency(dependency: string | null): string {
  const depMap: Record<string, string> = {
    'VERY_SEVERE': 'Muito Grave',  // ClickUp: "MUY GRAVE"
    'SEVERE':      'Grave',         // ClickUp: "GRAVE"
    'MODERATE':    'Moderado',      // ClickUp: "MODERADA"
    'MILD':        'Leve',          // ClickUp: "LEVE"
  };
  return depMap[dependency ?? ''] ?? 'Moderado';
}

export function getDependencyColor(dependency: string | null): string {
  const colorMap: Record<string, string> = {
    'VERY_SEVERE': 'text-[#ed0006]',  // ClickUp: "MUY GRAVE"
    'SEVERE':      'text-[#f9a000]',   // ClickUp: "GRAVE"
    'MODERATE':    'text-[#fdc405]',   // ClickUp: "MODERADA"
    'MILD':        'text-[#81c784]',   // ClickUp: "LEVE"
  };
  return colorMap[dependency ?? ''] ?? 'text-[#fdc405]';
}

// ── listVacancies query builder ────────────────────────────────────────────────

const LIST_VACANCIES_BASE = `
  SELECT
    jp.id,
    jp.case_number,
    jp.vacancy_number,
    jp.title,
    jp.status,
    p.zone_neighborhood as patient_zone,
    jp.search_start_date,
    jp.created_at,
    jp.updated_at,
    get_applicant_count(jp.id) AS current_applicants,
    jp.max_applicants,
    p.first_name as patient_first_name,
    p.last_name as patient_last_name,
    p.dependency_level,
    CASE
      WHEN jp.search_start_date IS NOT NULL
      THEN EXTRACT(DAY FROM NOW() - jp.search_start_date)::INTEGER
      ELSE 0
    END as dias_aberto,
    (SELECT COUNT(*) FROM encuadres e WHERE e.job_posting_id = jp.id) as convidados,
    (SELECT COUNT(DISTINCT worker_id) FROM encuadres e
      WHERE e.job_posting_id = jp.id AND e.worker_id IS NOT NULL) as postulados,
    (SELECT COUNT(*) FROM encuadres e
      WHERE e.job_posting_id = jp.id AND e.resultado = 'SELECCIONADO') as selecionados,
    CASE
      WHEN jp.providers_needed IS NOT NULL
      THEN jp.providers_needed::INTEGER - (
        SELECT COUNT(*) FROM encuadres e
        WHERE e.job_posting_id = jp.id AND e.resultado = 'SELECCIONADO'
      )
      ELSE NULL
    END as faltantes
  FROM job_postings jp
  LEFT JOIN patients p ON jp.patient_id = p.id
  WHERE jp.case_number IS NOT NULL
    AND jp.deleted_at IS NULL
`;

export interface ListVacanciesFilters {
  search?: unknown;
  client?: unknown;
  status?: unknown;
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

  if (filters.client) {
    baseQuery += ` AND p.insurance_verified = $${paramIndex}`;
    params.push(filters.client);
    paramIndex++;
  }

  if (filters.status === 'ativo') {
    baseQuery += ` AND jp.status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE','PENDING_ACTIVATION','ACTIVE')`;
  } else if (filters.status === 'inativo') {
    baseQuery += ` AND jp.status IN ('SUSPENDED','CLOSED')`;
  } else if (filters.status === 'processo') {
    baseQuery += ` AND jp.status IN ('SEARCHING_REPLACEMENT')`;
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
  dependency_level: string | null;
  dias_aberto: number | null;
  convidados: number | null;
  postulados: string | null;
  selecionados: string | null;
  faltantes: string | null;
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
    grau: mapDependency(row.dependency_level),
    grauColor: getDependencyColor(row.dependency_level),
    diasAberto: row.dias_aberto?.toString().padStart(2, '0') ?? '00',
    convidados: row.convidados?.toString().padStart(2, '0') ?? '00',
    postulados: row.postulados?.toString() ?? '',
    selecionados: row.selecionados?.toString() ?? '',
    faltantes: row.faltantes?.toString() ?? '',
  };
}
