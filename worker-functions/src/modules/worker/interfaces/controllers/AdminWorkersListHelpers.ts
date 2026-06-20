/**
 * AdminWorkersListHelpers
 *
 * Presentation-layer helpers for AdminWorkersController.listWorkers.
 * Extracted to keep AdminWorkersController within the 400-line limit.
 *
 * Builds the WHERE clause and params array for the worker list query,
 * including the 9 new profile-filters added in migration 218.
 *
 * Address table choice:
 *   worker_service_areas — actively populated via ServiceAreaRepository and
 *   UpdateWorkerProfileFieldsUseCase (city + state columns). worker_locations
 *   was deprecated (consolidated into worker_service_areas, migrations 158-160)
 *   and has zero active INSERTs in the codebase. See wave2-schema-migrations
 *   test skip comment for confirmation.
 */

import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';

// ── Enum allowlists ────────────────────────────────────────────────────────────

const VALID_PROFESSIONS: ReadonlySet<string> = new Set([
  'AT',
  'CAREGIVER',
  'NURSE',
  'KINESIOLOGIST',
  'PSYCHOLOGIST',
]);

// ── Public filter interface ────────────────────────────────────────────────────

export interface WorkerListFilters {
  platform?: string;
  docs_complete?: string;
  docs_validated?: 'all_validated' | 'pending_validation';
  search?: string;
  case_id?: string;
  tag_ids?: string;
  /** CSV of profession values: AT,CAREGIVER,NURSE,... */
  profession?: string;
  /** Single value — matches $value = ANY(w.preferred_age_range) */
  preferred_age_range?: string;
  /** Single value — matches $value = ANY(w.experience_types) */
  experience_type?: string;
  /** Single value — matches $value = ANY(w.preferred_types) */
  preferred_type?: string;
  /** Single language code — blind-index search via languages_bidx */
  language?: string;
  /** 'male' | 'female' — blind-index search via sex_bidx */
  sex?: string;
  /** Province/state — EXISTS on worker_service_areas.state ILIKE */
  state?: string;
  /** City — EXISTS on worker_service_areas.city ILIKE */
  city?: string;
  /** CSV of day-of-week ints (0-6) — EXISTS on worker_availability.day_of_week */
  days?: string;
  limit: string;
  offset: string;
}

export interface WorkerListQuery {
  whereClause: string;
  params: unknown[];
  paramIndex: number;
}

// ── Builder ────────────────────────────────────────────────────────────────────

/**
 * Builds the WHERE clause and params for GET /api/admin/workers.
 * Handles all non-search filters synchronously (search is handled in controller).
 *
 * Returns { whereClause, params, paramIndex } for further composition.
 */
export function buildWorkerListWhereClause(filters: WorkerListFilters): WorkerListQuery {
  const params: unknown[] = [];
  let paramIndex = 1;
  let whereClause = 'WHERE w.merged_into_id IS NULL';

  // ── Platform ────────────────────────────────────────────────────────────────
  if (filters.platform) {
    if (filters.platform === 'talentum') {
      whereClause += ` AND (w.data_sources && ARRAY['candidatos', 'candidatos_no_terminaron']::text[])`;
    } else if (filters.platform === 'enlite_app') {
      whereClause += ` AND (w.data_sources IS NULL OR w.data_sources = '{}')`;
    } else {
      whereClause += ` AND ($${paramIndex} = ANY(w.data_sources))`;
      params.push(filters.platform);
      paramIndex++;
    }
  }

  // ── Docs complete ───────────────────────────────────────────────────────────
  if (filters.docs_complete === 'complete') {
    whereClause += ` AND w.status = 'REGISTERED'`;
  } else if (filters.docs_complete === 'incomplete') {
    whereClause += ` AND w.status = 'INCOMPLETE_REGISTER'`;
  }

  // ── Case ────────────────────────────────────────────────────────────────────
  if (filters.case_id) {
    whereClause += ` AND EXISTS (SELECT 1 FROM encuadres e2 WHERE e2.worker_id = w.id AND e2.job_posting_id = $${paramIndex})`;
    params.push(filters.case_id);
    paramIndex++;
  }

  // ── Tags (AND semantics — worker must have ALL tags) ────────────────────────
  if (filters.tag_ids) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const tagArray = filters.tag_ids.split(',').map((t) => t.trim()).filter(Boolean);
    const invalidUuids = tagArray.filter((t) => !UUID_RE.test(t));
    if (invalidUuids.length > 0) {
      // Caller must validate before calling this function.
      // If invalid UUIDs slip through, the query will be safe (no SQL injection)
      // but may return unexpected results. The controller validates first.
    } else if (tagArray.length > 0) {
      whereClause += ` AND (SELECT COUNT(DISTINCT wt.tag_id) FROM worker_tags wt WHERE wt.worker_id = w.id AND wt.tag_id = ANY($${paramIndex}::uuid[])) = $${paramIndex + 1}`;
      params.push(tagArray, tagArray.length);
      paramIndex += 2;
    }
  }

  // ── Profession (CSV allowlist) ──────────────────────────────────────────────
  if (typeof filters.profession === 'string' && filters.profession.trim() !== '') {
    const professions = filters.profession
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter((p) => VALID_PROFESSIONS.has(p));
    if (professions.length > 0) {
      whereClause += ` AND w.profession = ANY($${paramIndex}::text[])`;
      params.push(professions);
      paramIndex++;
    }
  }

  // ── Preferred age range (single value) ─────────────────────────────────────
  if (typeof filters.preferred_age_range === 'string' && filters.preferred_age_range.trim() !== '') {
    whereClause += ` AND $${paramIndex} = ANY(w.preferred_age_range)`;
    params.push(filters.preferred_age_range.trim());
    paramIndex++;
  }

  // ── Experience type (single value) ─────────────────────────────────────────
  if (typeof filters.experience_type === 'string' && filters.experience_type.trim() !== '') {
    whereClause += ` AND $${paramIndex} = ANY(w.experience_types)`;
    params.push(filters.experience_type.trim());
    paramIndex++;
  }

  // ── Preferred type (single value) ───────────────────────────────────────────
  if (typeof filters.preferred_type === 'string' && filters.preferred_type.trim() !== '') {
    whereClause += ` AND $${paramIndex} = ANY(w.preferred_types)`;
    params.push(filters.preferred_type.trim());
    paramIndex++;
  }

  // ── State / province (EXISTS on worker_service_areas) ──────────────────────
  // Uses worker_service_areas (not worker_locations which was deprecated via mig 160).
  if (typeof filters.state === 'string' && filters.state.trim() !== '') {
    whereClause += ` AND EXISTS (SELECT 1 FROM worker_service_areas wsa WHERE wsa.worker_id = w.id AND wsa.state ILIKE $${paramIndex})`;
    params.push(filters.state.trim());
    paramIndex++;
  }

  // ── City (EXISTS on worker_service_areas) ───────────────────────────────────
  if (typeof filters.city === 'string' && filters.city.trim() !== '') {
    whereClause += ` AND EXISTS (SELECT 1 FROM worker_service_areas wsa WHERE wsa.worker_id = w.id AND wsa.city ILIKE $${paramIndex})`;
    params.push(filters.city.trim());
    paramIndex++;
  }

  // ── Days (EXISTS on worker_availability) ────────────────────────────────────
  if (typeof filters.days === 'string' && filters.days.trim() !== '') {
    const dayInts = filters.days
      .split(',')
      .map((d) => parseInt(d.trim(), 10))
      .filter((d) => !isNaN(d) && d >= 0 && d <= 6);
    if (dayInts.length > 0) {
      whereClause += ` AND EXISTS (SELECT 1 FROM worker_availability av WHERE av.worker_id = w.id AND av.day_of_week = ANY($${paramIndex}::int[]))`;
      params.push(dayInts);
      paramIndex++;
    }
  }

  return { whereClause, params, paramIndex };
}

// ── Async blind-index filters (called from controller after sync build) ────────

/**
 * Appends sex blind-index filter to whereClause.
 * Returns null if the value normalizes to null (filter skipped).
 */
export async function appendSexFilter(
  blindIndexService: BlindIndexService,
  whereClause: string,
  params: unknown[],
  paramIndex: number,
  sexRaw: string | undefined,
): Promise<{ whereClause: string; params: unknown[]; paramIndex: number }> {
  if (!sexRaw || sexRaw.trim() === '') {
    return { whereClause, params, paramIndex };
  }
  const canonical = normalizeSexValue(sexRaw);
  if (canonical === null) {
    return { whereClause, params, paramIndex };
  }
  const bidxBuffer = await blindIndexService.generateValueBidx(canonical);
  if (bidxBuffer === null) {
    return { whereClause, params, paramIndex };
  }
  const newWhere = whereClause + ` AND w.sex_bidx = $${paramIndex}`;
  const newParams = [...params, bidxBuffer];
  return { whereClause: newWhere, params: newParams, paramIndex: paramIndex + 1 };
}

/**
 * Appends language blind-index filter to whereClause.
 * Returns unchanged if the language value is empty.
 */
export async function appendLanguageFilter(
  blindIndexService: BlindIndexService,
  whereClause: string,
  params: unknown[],
  paramIndex: number,
  language: string | undefined,
): Promise<{ whereClause: string; params: unknown[]; paramIndex: number }> {
  if (!language || language.trim() === '') {
    return { whereClause, params, paramIndex };
  }
  const bidxBuffer = await blindIndexService.generateValueBidx(language.trim());
  if (bidxBuffer === null) {
    return { whereClause, params, paramIndex };
  }
  const serialized = blindIndexService.serializeForPg([bidxBuffer]);
  if (serialized === null) {
    return { whereClause, params, paramIndex };
  }
  const newWhere = whereClause + ` AND w.languages_bidx @> $${paramIndex}::bytea[]`;
  const newParams = [...params, serialized];
  return { whereClause: newWhere, params: newParams, paramIndex: paramIndex + 1 };
}
