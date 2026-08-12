import type { PublicJobRow, PublicJobDto } from '../domain/PublicJobDto';
import { formatScheduleToText } from './formatScheduleToText';
import { buildScheduleWeek } from './buildScheduleWeek';

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

/**
 * `location_label` — rótulo único de localização pro consumidor externo (o portal
 * WordPress `filtro-avancado-vacantes`) exibir no título do accordion sem re-parsear
 * nem escolher entre 3 campos. Pega o mais ESPECÍFICO disponível:
 * bairro → cidade → estado (barrio → localidad → provincia).
 *
 * Por que o mais específico, e não a província: medido nas 183 vagas AR ativas,
 * ~90% estão em `CABA`/`Provincia de Buenos Aires` — a província sozinha não
 * distingue as vagas (o problema que a task pede pra resolver). O barrio/localidad
 * é o discriminador real ("Palermo", "Barracas", "Ramos Mejía").
 *
 * Derivado em tempo de request — NÃO cria coluna nova; usa campos que a query já traz.
 */
export function resolveLocationLabel(row: PublicJobRow): string | null {
  for (const candidate of [row.neighborhood, row.city, row.state]) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return null;
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
    location_label: resolveLocationLabel(row),
    country: row.country ?? null,
    age_range_min: row.age_range_min ?? null,
    age_range_max: row.age_range_max ?? null,
    whatsapp_url: row.whatsapp_url ?? null,
    schedule_week: buildScheduleWeek(row.schedule),
  };
}
