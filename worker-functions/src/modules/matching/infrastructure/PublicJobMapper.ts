import type { PublicJobRow, PublicJobDto } from '../domain/PublicJobDto';
import { formatScheduleToText } from './formatScheduleToText';

/**
 * Public `description` is sourced from `job_postings.talentum_description` — the
 * AI-generated, PII-free description (the only description column that exists).
 * The legacy `description` column (raw ClickUp dump with patient PII) was dropped
 * in migration 214. No placeholder stripping needed anymore — just trim/null-guard.
 */
export function sanitizeDescription(raw: string | null): string {
  return raw?.trim() ?? '';
}

function normalizeStateCity(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  return raw;
}

function normalizeWorkerType(raw: string[] | null): string[] | null {
  if (!raw || raw.length === 0) return null;
  return raw;
}

/**
 * `schedule_days_hours` (coluna legada, só preenchida no import ClickUp) fica
 * NULL/vazia em vagas novas. Fallback: deriva o texto a partir do JSONB
 * `job_postings.schedule`, que toda vaga nova (Gemini/form admin) preenche.
 * O legado, quando presente, sempre tem precedência — nunca sobrescrito.
 */
function resolveScheduleDaysHours(row: PublicJobRow): string | null {
  if (row.schedule_days_hours && row.schedule_days_hours.trim()) {
    return row.schedule_days_hours;
  }
  return formatScheduleToText(row.schedule);
}

export function mapPublicJobRow(row: PublicJobRow): PublicJobDto {
  return {
    id: row.id,
    case_number: row.case_number,
    vacancy_number: row.vacancy_number,
    title: row.title,
    status: row.status,
    description: sanitizeDescription(row.description),
    schedule_days_hours: resolveScheduleDaysHours(row),
    worker_profile_sought: row.worker_profile_sought,
    service: row.service,
    pathologies: row.pathologies,
    state: row.state,
    city: row.city,
    detail_link: row.detail_link,
    worker_type: normalizeWorkerType(row.worker_type),
    worker_sex: row.worker_sex ?? null,
    job_zone: row.job_zone ?? null,
    neighborhood: row.neighborhood ?? null,
    state_city: normalizeStateCity(row.state_city),
    country: row.country ?? null,
    age_range_min: row.age_range_min ?? null,
    age_range_max: row.age_range_max ?? null,
    whatsapp_url: row.whatsapp_url ?? null,
  };
}
