/**
 * enrich-vacancies-helpers.ts
 *
 * Validators, DB helpers, retry logic, and text builders for vacancy enrichment.
 *
 * The original CLI consumer (enrich-vacancies-with-gemini.ts) was removed in
 * 2026-05-01 — see docs/FOLLOWUPS.md TD-002. These helpers stay because their
 * E2E invariants (idempotency, fill-only, guard against invalid output) are
 * exercised by tests/e2e/phase3-enrichment-invariants.e2e.test.ts and
 * document the contract any future enrichment path must honor.
 *
 * Pure validator functions have no side-effects — safe to unit test in isolation.
 * DB helpers and the Gemini retry wrapper require real dependencies.
 */

/* eslint-disable no-console */

import { Pool } from 'pg';
import { isProfession } from '../src/modules/worker/domain/enums/Profession';
import type { GeminiVacancyParserService } from '../src/modules/integration/infrastructure/GeminiVacancyParserService';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScheduleEntry {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface JobPostingRow {
  id: string;
  title: string | null;
  worker_profile_sought: string | null;
  schedule_days_hours: string | null;
  daily_obs: string | null;
  // service_address_raw dropped in migration 152 (lives in patient_addresses via patient_address_id FK)
  required_professions: string[] | null;
  schedule: unknown | null;
  required_sex: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
  required_experience: string | null;
  worker_attributes: string | null;
  // pathology_types dropped in migration 152 — use patients.diagnosis via patient_id FK
  // dependency_level dropped in migration 152 — use patients.dependency_level via patient_id FK
  // service_device_types dropped in migration 152 — use patients.service_type via patient_id FK
  salary_text: string | null;
  payment_day: string | null;
  enriched_at: string | null;
}

export interface ValidationCounters {
  invalid_schedule: number;
  invalid_required_sex: number;
  invalid_age_range: number;
  invalid_professions: number;
  invalid_fields_skipped: number;
}

export interface EnrichmentPatch {
  schedule: object | null;
  required_professions: string[];
  required_sex: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
  required_experience: string | null;
  worker_attributes: string | null;
  // pathology_types, dependency_level, service_device_types dropped in migration 152
  // Clinical data now lives in patients table — enrichment script no longer writes these.
  salary_text: string | null;
  payment_day: string | null;
}

export type WorkerType = 'AT' | 'CUIDADOR';

// ── Time format validation ─────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function isValidTime(t: string): boolean {
  return TIME_RE.test(t);
}

// ── validateSchedule ───────────────────────────────────────────────────────────

/**
 * Validates a Gemini-returned schedule array.
 * Returns all entries if ALL are valid; null if ANY entry is invalid
 * (conservative: drop whole field rather than partial data).
 *
 * dayOfWeek: [0, 6] — 0 = Sunday (Postgres/ISO convention).
 * startTime / endTime: HH:MM or HH:MM:SS.
 */
export function validateSchedule(
  entries: unknown,
  counters: ValidationCounters,
): ScheduleEntry[] | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as ScheduleEntry).dayOfWeek !== 'number' ||
      typeof (entry as ScheduleEntry).startTime !== 'string' ||
      typeof (entry as ScheduleEntry).endTime !== 'string'
    ) {
      counters.invalid_schedule++;
      counters.invalid_fields_skipped++;
      return null;
    }

    const { dayOfWeek, startTime, endTime } = entry as ScheduleEntry;

    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      counters.invalid_schedule++;
      counters.invalid_fields_skipped++;
      return null;
    }

    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      counters.invalid_schedule++;
      counters.invalid_fields_skipped++;
      return null;
    }
  }

  return entries as ScheduleEntry[];
}

// ── validateRequiredSex ────────────────────────────────────────────────────────

const VALID_SEX_VALUES = new Set(['M', 'F']);

/**
 * Accepts 'M' | 'F' | null.
 * Normalises common Gemini variants: MASCULINO→M, MALE→M, FEMENINO→F, FEMALE→F.
 * Anything else (including 'X', 'BOTH', objects) → null + increments counters.
 */
export function validateRequiredSex(
  value: unknown,
  counters: ValidationCounters,
): 'M' | 'F' | null {
  if (value === null || value === undefined) return null;

  if (typeof value !== 'string') {
    counters.invalid_required_sex++;
    counters.invalid_fields_skipped++;
    return null;
  }

  const upper = value.toUpperCase().trim();

  if (upper === 'MASCULINO' || upper === 'MALE') return 'M';
  if (upper === 'FEMENINO' || upper === 'FEMALE') return 'F';

  if (VALID_SEX_VALUES.has(upper as 'M' | 'F')) return upper as 'M' | 'F';

  counters.invalid_required_sex++;
  counters.invalid_fields_skipped++;
  return null;
}

// ── validateAge ────────────────────────────────────────────────────────────────

/**
 * Returns integer >= 0 or null. Rejects negative, float, string.
 */
export function validateAge(
  value: unknown,
  counters: ValidationCounters,
): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    counters.invalid_age_range++;
    counters.invalid_fields_skipped++;
    return null;
  }

  return value;
}

// ── validateProfessions ────────────────────────────────────────────────────────

/**
 * Filters to only canonical Profession values (AT, CAREGIVER, NURSE, etc.).
 * Unknown strings are silently dropped (each drop increments the counter).
 */
export function validateProfessions(
  values: unknown,
  counters: ValidationCounters,
): string[] {
  if (!Array.isArray(values)) return [];

  const result: string[] = [];
  for (const v of values) {
    if (typeof v === 'string' && isProfession(v)) {
      result.push(v);
    } else {
      counters.invalid_professions++;
      counters.invalid_fields_skipped++;
    }
  }
  return result;
}

// ── buildInputText ─────────────────────────────────────────────────────────────

/**
 * Builds the free-text prompt input to send to Gemini from available
 * job_posting fields. Only includes sections where a value is present.
 */
export function buildInputText(row: Pick<
  JobPostingRow,
  'title' | 'worker_profile_sought' | 'schedule_days_hours' | 'daily_obs'
>): string {
  const parts: string[] = [];
  if (row.title)                  parts.push(`Título: ${row.title}`);
  if (row.worker_profile_sought)  parts.push(`Perfil buscado: ${row.worker_profile_sought}`);
  if (row.schedule_days_hours)    parts.push(`Horários: ${row.schedule_days_hours}`);
  if (row.daily_obs)              parts.push(`Observações: ${row.daily_obs}`);
  // service_address_raw dropped in migration 152 — address lives in patient_addresses
  return parts.join('\n');
}

// ── inferWorkerType ────────────────────────────────────────────────────────────

/**
 * Infers workerType from existing data or text heuristics.
 * Priority: existing required_professions > title/profile text > default AT.
 */
export function inferWorkerType(row: Pick<
  JobPostingRow,
  'required_professions' | 'title' | 'worker_profile_sought'
>): WorkerType {
  if (row.required_professions && row.required_professions.length > 0) {
    return row.required_professions[0].toUpperCase() === 'CAREGIVER' ? 'CUIDADOR' : 'AT';
  }

  const combined = [row.title, row.worker_profile_sought]
    .filter(Boolean).join(' ').toLowerCase();

  return (combined.includes('cuidador') || combined.includes('caregiver')) ? 'CUIDADOR' : 'AT';
}

// ── sleep ──────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

// pathology_types, dependency_level, service_device_types dropped in migration 152.
// Clinical data (diagnosis, dependency_level, service_type) now lives in patients table.
const UPDATE_PARAMS = (id: string, patch: EnrichmentPatch) => [
  patch.schedule !== null ? JSON.stringify(patch.schedule) : null,
  patch.required_professions,
  patch.required_sex,
  patch.age_range_min,
  patch.age_range_max,
  patch.required_experience,
  patch.worker_attributes,
  patch.salary_text,
  patch.payment_day,
  id,
];

/** Fill-only UPDATE — COALESCE semantics; never overwrites existing values. */
export async function applyEnrichment(
  pool: Pool, id: string, patch: EnrichmentPatch,
): Promise<void> {
  await pool.query(
    `UPDATE job_postings SET
      schedule = COALESCE(
        CASE WHEN schedule IS NULL OR schedule = 'null'::jsonb THEN $1::jsonb ELSE schedule END,
        schedule),
      required_professions = CASE
        WHEN required_professions IS NULL OR required_professions = '{}'
        THEN $2 ELSE required_professions END,
      required_sex        = COALESCE(required_sex, $3),
      age_range_min       = COALESCE(age_range_min, $4),
      age_range_max       = COALESCE(age_range_max, $5),
      required_experience = COALESCE(required_experience, $6),
      worker_attributes   = COALESCE(worker_attributes, $7),
      salary_text         = COALESCE(salary_text, $8),
      payment_day         = COALESCE(payment_day, $9),
      enriched_at         = NOW(),
      updated_at          = NOW()
    WHERE id = $10`,
    UPDATE_PARAMS(id, patch),
  );
}

/** Force-mode UPDATE — overwrites all enrichment fields unconditionally. */
export async function applyEnrichmentForce(
  pool: Pool, id: string, patch: EnrichmentPatch,
): Promise<void> {
  await pool.query(
    `UPDATE job_postings SET
      schedule             = $1::jsonb,
      required_professions = $2,
      required_sex         = $3,
      age_range_min        = $4,
      age_range_max        = $5,
      required_experience  = $6,
      worker_attributes    = $7,
      salary_text          = $8,
      payment_day          = $9,
      enriched_at          = NOW(),
      updated_at           = NOW()
    WHERE id = $10`,
    UPDATE_PARAMS(id, patch),
  );
}

// ── Gemini retry wrapper ───────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

type GeminiCounters = { gemini_success: number; gemini_retry: number; gemini_failure: number };
type GeminiResult = { vacancy: Awaited<ReturnType<GeminiVacancyParserService['parseFromTalentumDescription']>> };

/**
 * Calls gemini.parseFromTalentumDescription with exponential-backoff retry on 429/500/503.
 * Uses the inline-prompt variant (not parseFromText, which requires PROMPT_DOC_ID_* env vars
 * pointing at Google Docs — unavailable in offline/CI environments).
 *
 * The _workerType parameter is accepted but unused (kept for API compatibility with callers
 * that still want to classify AT vs CUIDADOR). Returns null after MAX_RETRIES failures.
 */
export async function callGeminiWithRetry(
  gemini: GeminiVacancyParserService,
  text: string,
  _workerType: WorkerType,
  counters: GeminiCounters,
  title: string = '',
): Promise<GeminiResult | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const vacancy = await gemini.parseFromTalentumDescription(text, title);
      counters.gemini_success++;
      if (attempt > 0) counters.gemini_retry++;
      return { vacancy };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable =
        msg.includes('429') || msg.includes('500') ||
        msg.includes('503') || msg.includes('network') || msg.includes('timeout');

      if (!isRetryable || attempt === MAX_RETRIES - 1) {
        counters.gemini_failure++;
        console.error(`  ERROR  Gemini final failure: ${msg}`);
        return null;
      }

      const delay = RETRY_DELAYS[attempt] ?? 4000;
      console.warn(`  WARN  Gemini error (attempt ${attempt + 1}): ${msg}. Retry in ${delay}ms…`);
      await sleep(delay);
    }
  }
  counters.gemini_failure++;
  return null;
}
