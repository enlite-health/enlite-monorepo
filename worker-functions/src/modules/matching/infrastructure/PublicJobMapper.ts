import type { PublicJobRow, PublicJobDto } from '../domain/PublicJobDto';

const GENERIC_DESCRIPTION_PREFIXES = [
  'caso operacional importado',
  'caso operacional',
];

export function sanitizeDescription(raw: string | null): string {
  if (!raw) return '';
  const lower = raw.trim().toLowerCase();
  if (GENERIC_DESCRIPTION_PREFIXES.some(p => lower.startsWith(p))) return '';
  return raw.trim();
}

function normalizeStateCity(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  return raw;
}

function normalizeWorkerType(raw: string[] | null): string[] | null {
  if (!raw || raw.length === 0) return null;
  return raw;
}

export function mapPublicJobRow(row: PublicJobRow): PublicJobDto {
  return {
    id: row.id,
    case_number: row.case_number,
    vacancy_number: row.vacancy_number,
    title: row.title,
    status: row.status,
    description: sanitizeDescription(row.description),
    schedule_days_hours: row.schedule_days_hours,
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
  };
}
