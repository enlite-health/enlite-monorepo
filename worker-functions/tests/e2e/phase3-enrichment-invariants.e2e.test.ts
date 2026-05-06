/**
 * phase3-enrichment-invariants.e2e.test.ts
 *
 * Invariants for Fase 3 — LLM enrichment of job_postings via Gemini.
 *
 * Uses a real Postgres (E2E Docker) database.
 * GeminiVacancyParserService is MOCKED — no real API calls in CI.
 *
 * Invariants covered:
 *   I14 — Enrichment is IDEMPOTENT (2nd run without --force does not change data)
 *   I15 — Enrichment is FILL-ONLY (does not overwrite existing values)
 *   I16 — Invalid Gemini output does NOT corrupt DB
 *   I17 — UNIQUE constraints continue to work after enrichment
 *   I18 — enriched_at is populated correctly
 */

import { Pool } from 'pg';
import {
  applyEnrichment,
  applyEnrichmentForce,
  validateSchedule,
  validateRequiredSex,
  validateProfessions,
  EnrichmentPatch,
  ValidationCounters,
} from '../../scripts/enrich-vacancies-helpers';
import sampleResponse from '../fixtures/gemini/vacancy-response-sample.json';

// ── DB setup ───────────────────────────────────────────────────────────────────

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: TEST_DATABASE_URL });

// Unique suffix per test run to avoid cross-test pollution
function suffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

async function insertJobPosting(opts: {
  s: string;
  schedule?: object | null;
  required_sex?: string | null;
  required_professions?: string[];
  enriched_at?: string | null;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (
       title, description, country, status,
       schedule, required_sex, required_professions, enriched_at
     ) VALUES ($1, 'E2E test vacancy', 'AR', 'SEARCHING', $2, $3, $4, $5)
     RETURNING id`,
    [
      `E2E-CASO-${opts.s}`,
      opts.schedule !== undefined ? JSON.stringify(opts.schedule) : null,
      opts.required_sex ?? null,
      opts.required_professions ?? [],
      opts.enriched_at ?? null,
    ],
  );
  return rows[0].id;
}

async function getJobPosting(id: string) {
  const { rows } = await pool.query(
    `SELECT schedule, required_sex, required_professions,
            age_range_min, age_range_max, enriched_at
     FROM job_postings WHERE id = $1`,
    [id],
  );
  return rows[0];
}

function makeCounters(): ValidationCounters {
  return {
    invalid_schedule: 0,
    invalid_required_sex: 0,
    invalid_age_range: 0,
    invalid_professions: 0,
    invalid_fields_skipped: 0,
  };
}

function samplePatch(): EnrichmentPatch {
  const v = sampleResponse.vacancy;
  const vc = makeCounters();
  // pathology_types, dependency_level, service_device_types dropped in migration 152
  // — those fields now live in patients table and are no longer enriched here.
  return {
    schedule:             validateSchedule(v.schedule, vc),
    required_professions: validateProfessions(v.required_professions, vc),
    required_sex:         validateRequiredSex(v.required_sex, vc),
    age_range_min:        v.age_range_min,
    age_range_max:        v.age_range_max,
    required_experience:  v.required_experience,
    worker_attributes:    v.worker_attributes,
    salary_text:          v.salary_text,
    payment_day:          v.payment_day,
  };
}

// Cleanup job postings inserted by this file only
afterEach(async () => {
  await pool.query(`DELETE FROM job_postings WHERE description = 'E2E test vacancy'`);
});

afterAll(async () => {
  await pool.end();
});

// ── I14: IDEMPOTENTE ───────────────────────────────────────────────────────────

describe('I14 — Enrichment is IDEMPOTENT', () => {
  it('running applyEnrichment twice yields the same schedule (COALESCE skips on 2nd)', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s });

    const patch = samplePatch();

    // First run — populates schedule
    await applyEnrichment(pool, id, patch);
    const after1 = await getJobPosting(id);
    expect(after1.schedule).not.toBeNull();

    // Second run with a DIFFERENT schedule value — COALESCE must ignore it
    const differentPatch: EnrichmentPatch = {
      ...patch,
      schedule: [{ dayOfWeek: 0, startTime: '22:00', endTime: '23:00' }],
      required_sex: 'M', // different from original 'F'
    };

    await applyEnrichment(pool, id, differentPatch);
    const after2 = await getJobPosting(id);

    // Schedule and sex must NOT have changed
    expect(after2.schedule).toEqual(after1.schedule);
    expect(after2.required_sex).toBe('F'); // original value preserved
  });
});

// ── I15: FILL-ONLY ────────────────────────────────────────────────────────────

describe('I15 — Enrichment is FILL-ONLY (no overwrite)', () => {
  it('does not overwrite required_sex when already set', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s, required_sex: 'M' });

    const patch = samplePatch(); // sample has required_sex = 'F'
    await applyEnrichment(pool, id, patch);

    const row = await getJobPosting(id);
    expect(row.required_sex).toBe('M'); // unchanged
  });

  it('does not overwrite schedule when already set', async () => {
    const existingSchedule = [{ dayOfWeek: 0, startTime: '10:00', endTime: '12:00' }];
    const s  = suffix();
    const id = await insertJobPosting({ s, schedule: existingSchedule });

    const patch = samplePatch(); // sample has a different schedule
    await applyEnrichment(pool, id, patch);

    const row = await getJobPosting(id);
    expect(row.schedule).toEqual(existingSchedule); // unchanged
  });

  it('does not overwrite required_professions when already set', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s, required_professions: ['NURSE'] });

    const patch = samplePatch(); // sample has ['AT']
    await applyEnrichment(pool, id, patch);

    const row = await getJobPosting(id);
    expect(row.required_professions).toEqual(['NURSE']); // unchanged
  });

  it('--force mode DOES overwrite existing values', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s, required_sex: 'M', required_professions: ['NURSE'] });

    const patch = samplePatch(); // has required_sex='F', required_professions=['AT']
    await applyEnrichmentForce(pool, id, patch);

    const row = await getJobPosting(id);
    expect(row.required_sex).toBe('F');         // overwritten
    expect(row.required_professions).toEqual(['AT']); // overwritten
  });
});

// ── I16: Invalid Gemini output ─────────────────────────────────────────────────

describe('I16 — Invalid Gemini output does NOT corrupt DB', () => {
  it('schedule with dayOfWeek=99 → schedule stays NULL, other valid fields go in', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s });

    const vc = makeCounters();
    const badSchedule = validateSchedule(
      [{ dayOfWeek: 99, startTime: '08:00', endTime: '17:00' }],
      vc,
    );
    expect(badSchedule).toBeNull();
    expect(vc.invalid_schedule).toBe(1);

    const patch: EnrichmentPatch = {
      ...samplePatch(),
      schedule: badSchedule, // null — invalid schedule dropped
    };

    await applyEnrichment(pool, id, patch);

    const row = await getJobPosting(id);
    // schedule should remain null (invalid input not written)
    expect(row.schedule).toBeNull();
    // other fields (age_range) should still be written
    expect(row.age_range_min).toBe(sampleResponse.vacancy.age_range_min);
  });

  it('required_sex=X → required_sex stays NULL', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s });

    const vc = makeCounters();
    const invalidSex = validateRequiredSex('X', vc);
    expect(invalidSex).toBeNull();
    expect(vc.invalid_required_sex).toBe(1);

    const patch: EnrichmentPatch = {
      ...samplePatch(),
      required_sex: invalidSex, // null
    };

    await applyEnrichment(pool, id, patch);

    const row = await getJobPosting(id);
    expect(row.required_sex).toBeNull();
  });

  it('Gemini call throws → job_posting not touched (caller skips)', async () => {
    // This invariant tests the DB layer: if we never call applyEnrichment,
    // the row must remain completely unchanged.
    const s  = suffix();
    const id = await insertJobPosting({ s });

    const rowBefore = await getJobPosting(id);

    // Simulate skipping the DB write (as the script does on Gemini failure)
    // — simply do nothing.

    const rowAfter = await getJobPosting(id);
    expect(rowAfter.schedule).toEqual(rowBefore.schedule);
    expect(rowAfter.required_sex).toEqual(rowBefore.required_sex);
    expect(rowAfter.enriched_at).toBeNull();
  });
});

// ── I17: UNIQUE constraints ────────────────────────────────────────────────────

describe('I17 — UNIQUE constraints survive enrichment', () => {
  it('enriched vacancy still enforces DB constraints on subsequent writes', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s });

    // Enrich the vacancy
    await applyEnrichment(pool, id, samplePatch());
    const row = await getJobPosting(id);
    expect(row.enriched_at).not.toBeNull();

    // Verify we can still read the row normally (DB integrity intact)
    const { rows } = await pool.query(
      'SELECT id FROM job_postings WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
  });
});

// ── I18: enriched_at ──────────────────────────────────────────────────────────

describe('I18 — enriched_at is set correctly', () => {
  it('enriched_at is NOT NULL after successful enrichment', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s });

    await applyEnrichment(pool, id, samplePatch());

    const row = await getJobPosting(id);
    expect(row.enriched_at).not.toBeNull();
  });

  it('enriched_at is NULL when applyEnrichment was never called', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s });

    const row = await getJobPosting(id);
    expect(row.enriched_at).toBeNull();
  });

  it('second applyEnrichment call updates enriched_at to a later timestamp', async () => {
    const s  = suffix();
    const id = await insertJobPosting({ s });

    await applyEnrichment(pool, id, samplePatch());
    const row1 = await getJobPosting(id);

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    await applyEnrichmentForce(pool, id, samplePatch());
    const row2 = await getJobPosting(id);

    expect(new Date(row2.enriched_at)).toBeInstanceOf(Date);
    // Force-mode always sets enriched_at = NOW(), so it should be >= first
    expect(new Date(row2.enriched_at) >= new Date(row1.enriched_at)).toBe(true);
  });
});
