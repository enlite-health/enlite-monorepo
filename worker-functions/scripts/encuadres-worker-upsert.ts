/**
 * encuadres-worker-upsert.ts
 *
 * Worker upsert logic (fill-only) used by import-encuadres-from-clickup.ts.
 * Extracted to keep the main script under 400 lines.
 */

import { Pool } from 'pg';
import { generatePhoneCandidates } from '../src/shared/utils/phoneNormalization';
import { KMSEncryptionService } from '../src/shared/security/KMSEncryptionService';
import { BlindIndexService } from '../src/shared/security/BlindIndexService';

export interface WorkerUpsertInput {
  email:          string | null;
  phone:          string | null; // E.164-normalized
  rawWhatsapp:    string | null;
  firstName:      string | null;
  lastName:       string | null;
  birthDate:      Date | null;
  gender:         string | null; // gender identity (from "Sexo Prestador" Encuadres field)
  profession:     string | null;
  clickupTaskId:  string;  // required: used as source for synthetic auth_uid (same pattern as talentum_<id>)
}

export interface WorkerUpsertResult { id: string; created: boolean; }

/**
 * Upserts a worker with fill-only semantics:
 *   - Existing worker → only writes fields that are currently NULL
 *   - New worker      → INSERT with INCOMPLETE_REGISTER status and synthetic
 *                       auth_uid = 'clickup_encuadre_<taskId>' (follows same
 *                       pattern as SyncTalentumWorkersUseCase which uses 'talentum_<id>')
 * Always appends 'encuadres_clickup' to data_sources (idempotent via DISTINCT).
 */
export async function upsertWorkerFromEncuadre(
  data: WorkerUpsertInput,
  pool: Pool,
  enc: KMSEncryptionService,
  bidx: BlindIndexService,
): Promise<WorkerUpsertResult> {
  // ── Lookup: email → phone candidates ─────────────────────────────────────────
  let existingId: string | null = null;

  if (data.email) {
    const r = await pool.query(
      `SELECT id FROM workers WHERE LOWER(email) = LOWER($1) AND merged_into_id IS NULL LIMIT 1`,
      [data.email],
    );
    existingId = r.rows[0]?.id ?? null;
  }

  if (!existingId && data.phone) {
    const candidates = generatePhoneCandidates(data.phone);
    if (candidates.length > 0) {
      const r = await pool.query(
        `SELECT id FROM workers WHERE phone = ANY($1::text[]) AND merged_into_id IS NULL LIMIT 1`,
        [candidates],
      );
      existingId = r.rows[0]?.id ?? null;
    }
  }

  if (existingId) {
    await fillMissingWorkerFields(existingId, data, pool, enc, bidx);
    return { id: existingId, created: false };
  }

  return insertNewWorker(data, pool, enc, bidx);
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function fillMissingWorkerFields(
  workerId: string,
  data: WorkerUpsertInput,
  pool: Pool,
  enc: KMSEncryptionService,
  bidx: BlindIndexService,
): Promise<void> {
  const current = await pool.query(
    `SELECT email, phone, first_name_encrypted, last_name_encrypted,
            gender_encrypted, birth_date_encrypted, profession
     FROM workers WHERE id = $1`,
    [workerId],
  );
  const row = current.rows[0];
  if (!row) return;

  const sets: string[] = [];
  const vals: unknown[] = [];
  let p = 1;

  if (!row.email && data.email)         { sets.push(`email = $${p++}`);     vals.push(data.email); }
  // Phone fill com checagem de conflict (TD-001 — workers fragmentados em 4 silos
  // historicos: pretaln_*, firebase, anacare_*, base1import_*. O phone pode estar
  // em outro worker já — ver docs/TECHNICAL_DEBT.md). Se conflitar, skip phone update.
  if (!row.phone && data.phone) {
    const phoneCandidates = generatePhoneCandidates(data.phone);
    if (phoneCandidates.length > 0) {
      const collision = await pool.query(
        `SELECT id FROM workers WHERE phone = ANY($1::text[]) AND id != $2 AND merged_into_id IS NULL LIMIT 1`,
        [phoneCandidates, workerId],
      );
      if (collision.rows.length === 0) {
        sets.push(`phone = $${p++}`);
        vals.push(data.phone);
      } else {
        console.warn(
          `  WARN  TD-001 worker_id=${workerId} (sem phone) — phone "${data.phone}" já está em ` +
          `worker_id=${collision.rows[0].id}; skipping phone fill (provável dup, registrar pra Fase 5 — Worker Consolidation)`,
        );
      }
    }
  }
  if (!row.profession && data.profession) { sets.push(`profession = $${p++}`); vals.push(data.profession); }

  // PII fields — batch encrypt only missing ones
  const toEncrypt: Record<string, string> = {};
  if (!row.first_name_encrypted  && data.firstName)  toEncrypt.firstName  = data.firstName;
  if (!row.last_name_encrypted   && data.lastName)   toEncrypt.lastName   = data.lastName;
  if (!row.gender_encrypted      && data.gender)     toEncrypt.gender     = data.gender;
  if (!row.birth_date_encrypted  && data.birthDate) {
    toEncrypt.birthDate = data.birthDate.toISOString().split('T')[0];
  }

  if (Object.keys(toEncrypt).length > 0) {
    const encrypted = await enc.encryptBatch(toEncrypt);
    if (encrypted.firstName) { sets.push(`first_name_encrypted = $${p++}`);  vals.push(encrypted.firstName); }
    if (encrypted.lastName)  { sets.push(`last_name_encrypted = $${p++}`);   vals.push(encrypted.lastName); }
    if (encrypted.gender)    { sets.push(`gender_encrypted = $${p++}`);      vals.push(encrypted.gender); }
    if (encrypted.birthDate) { sets.push(`birth_date_encrypted = $${p++}`);  vals.push(encrypted.birthDate); }
  }

  // Blind index: recalculate if either name is being written for the first time.
  // Fetch the current encrypted names to compose the full name (one side may already be set).
  const writingFirstName = !row.first_name_encrypted && data.firstName !== null && data.firstName !== undefined;
  const writingLastName  = !row.last_name_encrypted  && data.lastName  !== null && data.lastName  !== undefined;
  if (writingFirstName || writingLastName) {
    const [currentFirstName, currentLastName] = await Promise.all([
      row.first_name_encrypted ? enc.decrypt(row.first_name_encrypted) : Promise.resolve(null),
      row.last_name_encrypted  ? enc.decrypt(row.last_name_encrypted)  : Promise.resolve(null),
    ]);
    const finalFirstName = writingFirstName ? (data.firstName ?? null) : (currentFirstName ?? null);
    const finalLastName  = writingLastName  ? (data.lastName  ?? null) : (currentLastName  ?? null);
    const bidxBuffers = await bidx.generateNameTrigramBidx(finalFirstName, finalLastName);
    const bidxLiteral = bidx.serializeForPg(bidxBuffers);
    sets.push(`name_trgm_bidx = $${p++}::bytea[]`);
    vals.push(bidxLiteral);
  }

  // Always append data_source (idempotent via DISTINCT)
  sets.push(
    `data_sources = ARRAY(SELECT DISTINCT unnest(array_append(COALESCE(data_sources, '{}'), 'encuadres_clickup'::text)))`,
  );
  sets.push(`updated_at = NOW()`);
  vals.push(workerId);

  await pool.query(`UPDATE workers SET ${sets.join(', ')} WHERE id = $${p}`, vals);
}

async function insertNewWorker(
  data: WorkerUpsertInput,
  pool: Pool,
  enc: KMSEncryptionService,
  bidx: BlindIndexService,
): Promise<WorkerUpsertResult> {
  const toEncrypt: Record<string, string> = {};
  if (data.firstName)  toEncrypt.firstName  = data.firstName;
  if (data.lastName)   toEncrypt.lastName   = data.lastName;
  if (data.gender)     toEncrypt.gender     = data.gender;
  if (data.birthDate)  toEncrypt.birthDate  = data.birthDate.toISOString().split('T')[0];

  const [encrypted, nameBidxBuffers] = await Promise.all([
    Object.keys(toEncrypt).length > 0
      ? enc.encryptBatch(toEncrypt)
      : Promise.resolve({} as Record<string, string | null>),
    bidx.generateNameTrigramBidx(data.firstName ?? null, data.lastName ?? null),
  ]);
  const nameBidxLiteral = bidx.serializeForPg(nameBidxBuffers);

  const authUid = `clickup_encuadre_${data.clickupTaskId}`;

  const result = await pool.query(
    `INSERT INTO workers (
       auth_uid, email, phone,
       first_name_encrypted, last_name_encrypted, gender_encrypted, birth_date_encrypted,
       profession, name_trgm_bidx, status, country, data_sources
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bytea[],'INCOMPLETE_REGISTER','AR',ARRAY['encuadres_clickup'])
     ON CONFLICT (auth_uid) DO UPDATE SET
       email                = COALESCE(workers.email,                EXCLUDED.email),
       phone                = COALESCE(workers.phone,                EXCLUDED.phone),
       first_name_encrypted = COALESCE(workers.first_name_encrypted, EXCLUDED.first_name_encrypted),
       last_name_encrypted  = COALESCE(workers.last_name_encrypted,  EXCLUDED.last_name_encrypted),
       gender_encrypted     = COALESCE(workers.gender_encrypted,     EXCLUDED.gender_encrypted),
       birth_date_encrypted = COALESCE(workers.birth_date_encrypted, EXCLUDED.birth_date_encrypted),
       profession           = COALESCE(workers.profession,           EXCLUDED.profession),
       name_trgm_bidx       = CASE
                                WHEN EXCLUDED.name_trgm_bidx IS NOT NULL THEN EXCLUDED.name_trgm_bidx
                                ELSE workers.name_trgm_bidx
                              END,
       data_sources         = ARRAY(SELECT DISTINCT unnest(array_append(COALESCE(workers.data_sources, '{}'), 'encuadres_clickup'::text))),
       updated_at           = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      authUid,
      data.email, data.phone,
      encrypted.firstName ?? null, encrypted.lastName ?? null,
      encrypted.gender ?? null, encrypted.birthDate ?? null,
      data.profession, nameBidxLiteral,
    ],
  );

  const row = result.rows[0];
  return { id: row.id, created: row.inserted === true };
}

// ── Job posting lookup ────────────────────────────────────────────────────────

export async function resolveJobPostingId(pool: Pool, caseNumber: number): Promise<string | null> {
  const r = await pool.query(
    `SELECT id FROM job_postings WHERE case_number = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [caseNumber],
  );
  return r.rows[0]?.id ?? null;
}
