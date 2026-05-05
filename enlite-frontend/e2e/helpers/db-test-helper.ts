/**
 * db-test-helper.ts
 *
 * Direct DB access helpers for integration E2E tests.
 * Uses `docker exec enlite-postgres psql` to run SQL without adding `pg`
 * as a frontend dependency (the same approach as admin-patient-detail-integration.e2e.ts).
 *
 * Connection target: enlite_e2e database on the Docker enlite-postgres container.
 */

import { execSync } from 'child_process';

// ── Constants ───────────────────────────────────────────────────────────────

const CONTAINER = 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

// ── Internal helpers ────────────────────────────────────────────────────────

/** Runs a SQL string inside the Docker container. Returns stdout. */
function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString();
  } catch (err: any) {
    throw new Error(`DB error: ${err.stderr?.toString() ?? err.message}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface InsertTestPatientOpts {
  status?: string;
  firstName?: string;
  lastName?: string;
  diagnosis?: string;
  dependencyLevel?: string;
  withAddress?: boolean;
  addressLat?: number;
  addressLng?: number;
}

export interface InsertTestPatientResult {
  patientId: string;
  addressId: string | null;
}

/**
 * Inserts a test patient (and optionally one primary address) directly into
 * the DB. Uses a unique `clickup_task_id` suffix to avoid collisions.
 */
export function insertTestPatient(
  opts: InsertTestPatientOpts = {},
): InsertTestPatientResult {
  const {
    status = 'ACTIVE',
    firstName = 'IntegTest',
    lastName = `Patient${Date.now()}`,
    diagnosis = 'TEA leve',
    dependencyLevel = 'SEVERE',
    withAddress = false,
    addressLat = -34.6037,
    addressLng = -58.3816,
  } = opts;

  const clickupTaskId = `E2E-INT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  runSQL(`
    INSERT INTO patients (
      clickup_task_id, first_name, last_name, status,
      diagnosis, dependency_level, country, created_at, updated_at
    ) VALUES (
      '${clickupTaskId}',
      '${firstName}',
      '${lastName}',
      '${status}',
      '${diagnosis}',
      '${dependencyLevel}',
      'AR',
      NOW(), NOW()
    )
  `);

  const idRow = runSQL(
    `SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`,
  );
  const patientId = extractUUID(idRow);
  if (!patientId) {
    throw new Error(`Could not find patient after insert (clickup_task_id=${clickupTaskId})`);
  }

  let addressId: string | null = null;

  if (withAddress) {
    runSQL(`
      INSERT INTO patient_addresses (
        patient_id, address_type, address_formatted, address_raw,
        lat, lng, display_order, source, created_at, updated_at
      ) VALUES (
        '${patientId}',
        'primary',
        'Av. Corrientes 1234, CABA, AR',
        'Av. Corrientes 1234, CABA',
        ${addressLat},
        ${addressLng},
        1,
        'manual',
        NOW(), NOW()
      )
    `);

    const addrRow = runSQL(
      `SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`,
    );
    addressId = extractUUID(addrRow);
  }

  return { patientId, addressId };
}

/**
 * Deletes all job_postings, patient_addresses and the patient itself for a
 * given patientId. Safe to call even if no rows exist or patientId is empty.
 */
export function cleanupTestPatient(patientId: string): void {
  if (!patientId || patientId === 'undefined') return;
  runSQL(`DELETE FROM job_postings WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM patient_addresses WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM patients WHERE id = '${patientId}'`);
}

export interface JobPostingRow {
  id: string;
  status: string;
  patient_id: string | null;
  patient_address_id: string | null;
  schedule: unknown;
  title: string;
  /** ISO timestamp string from Postgres timestamptz, or null. */
  published_at: string | null;
  /** ISO timestamp string from Postgres timestamptz, or null. */
  closes_at: string | null;
}

/** Fetches a job_posting row directly from the DB for assertion purposes. */
export function getVacancyById(id: string): JobPostingRow | null {
  const out = runSQL(
    `SELECT id, status, patient_id, patient_address_id, schedule::text AS schedule, title,
            published_at, closes_at
     FROM job_postings
     WHERE id = '${id}'`,
  );
  const lines = out.split('\n').filter(l => l.trim());
  // psql output: header + separator + data rows + count row
  // Find the data line (after the "---" separator)
  const sepIdx = lines.findIndex(l => l.startsWith('-'));
  if (sepIdx === -1) return null;
  const dataLine = lines[sepIdx + 1];
  if (!dataLine || dataLine.includes('(0 rows)')) return null;

  const parts = dataLine.split('|').map(s => s.trim());
  return {
    id: parts[0] ?? '',
    status: parts[1] ?? '',
    patient_id: parts[2] || null,
    patient_address_id: parts[3] || null,
    schedule: parts[4] || null,
    title: parts[5] ?? '',
    published_at: parts[6] || null,
    closes_at: parts[7] || null,
  };
}

/** Cleans up vacancies left by an integration test by id list. */
export function cleanupVacancies(ids: string[]): void {
  if (ids.length === 0) return;
  const idList = ids.map((id) => `'${id}'`).join(',');
  runSQL(`DELETE FROM job_postings WHERE id IN (${idList})`);
}

export interface InsertTestWorkerOpts {
  /** 'M' | 'F' — clear-text. Helper handles the KMS-testMode base64 encode. */
  sex?: 'M' | 'F' | null;
  occupation?: 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST' | null;
  firstName?: string;
  lastName?: string;
  phone?: string;
  lat?: number | null;
  lng?: number | null;
  /** Defaults to REGISTERED — the only status that passes the matchmaking SQL. */
  status?: 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED';
}

/**
 * Inserts a test worker (and optionally a worker_location row) directly into
 * the DB. Designed for matchmaking integration specs. PII fields are written
 * with base64-of-utf8 since `KMSEncryptionService` in test mode just decodes
 * base64 on `decrypt()` (USE_KMS_ENCRYPTION=false / NODE_ENV=test).
 */
export function insertTestWorker(opts: InsertTestWorkerOpts = {}): string {
  const {
    sex = null,
    occupation = null,
    firstName = `WMatch${Date.now()}`,
    lastName = 'IntegTest',
    phone = `+5491100000${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`,
    lat = null,
    lng = null,
    status = 'REGISTERED',
  } = opts;

  const enc = (v: string | null) =>
    v == null ? 'NULL' : `'${Buffer.from(v, 'utf8').toString('base64')}'`;

  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const authUid = `e2e-match-${uniq}`;
  const email = `e2e.match.${uniq}@test.local`;
  runSQL(`
    INSERT INTO workers (
      auth_uid, email, phone, status, country, occupation,
      first_name_encrypted, last_name_encrypted, sex_encrypted,
      created_at, updated_at
    ) VALUES (
      '${authUid}',
      '${email}',
      '${phone}',
      '${status}',
      'AR',
      ${occupation ? `'${occupation}'` : 'NULL'},
      ${enc(firstName)},
      ${enc(lastName)},
      ${enc(sex)},
      NOW(), NOW()
    )
  `);

  const idRow = runSQL(`SELECT id FROM workers WHERE phone = '${phone}'`);
  const workerId = extractUUID(idRow);
  if (!workerId) throw new Error(`Could not find worker after insert (phone=${phone})`);

  if (lat !== null && lng !== null) {
    runSQL(`
      INSERT INTO worker_locations (
        worker_id, country, lat, lng, created_at, updated_at
      ) VALUES (
        '${workerId}', 'AR', ${lat}, ${lng}, NOW(), NOW()
      )
    `);
  }
  return workerId;
}

/** Deletes a worker row (worker_locations and worker_job_applications cascade). */
export function cleanupTestWorker(workerId: string): void {
  if (!workerId || workerId === 'undefined') return;
  runSQL(`DELETE FROM worker_job_applications WHERE worker_id = '${workerId}'`);
  runSQL(`DELETE FROM workers WHERE id = '${workerId}'`);
}

export interface InsertBaseVacancyOpts {
  patientId: string;
  patientAddressId: string;
  caseNumber: number;
}

/**
 * Inserts a minimal base job_posting so the patient surfaces in
 * `/api/admin/vacancies/cases-for-select` (which INNER JOINs job_postings).
 * Use it in `beforeAll` of an integration spec that needs the case-select
 * dropdown to expose a freshly seeded patient.
 */
export function insertBaseVacancy(opts: InsertBaseVacancyOpts): string {
  const { patientId, patientAddressId, caseNumber } = opts;
  runSQL(`
    INSERT INTO job_postings (
      vacancy_number, case_number, title, description,
      patient_id, patient_address_id,
      required_professions, providers_needed,
      status, country, created_at, updated_at
    ) VALUES (
      nextval('job_postings_vacancy_number_seq'),
      ${caseNumber},
      'CASO ${caseNumber}-base',
      '',
      '${patientId}',
      '${patientAddressId}',
      ARRAY['AT']::varchar[],
      1,
      'PENDING_ACTIVATION',
      'AR',
      NOW(), NOW()
    )
  `);

  const idRow = runSQL(
    `SELECT id FROM job_postings WHERE patient_id = '${patientId}' AND case_number = ${caseNumber} ORDER BY created_at DESC LIMIT 1`,
  );
  const id = extractUUID(idRow);
  if (!id) throw new Error(`Could not find seeded base vacancy for patient ${patientId}`);
  return id;
}

/** Fetches all patient_addresses for a patient. */
export function getPatientAddresses(patientId: string): string[] {
  const out = runSQL(
    `SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' ORDER BY created_at`,
  );
  const lines = out.split('\n').filter(l => l.trim());
  const sepIdx = lines.findIndex(l => l.startsWith('-'));
  if (sepIdx === -1) return [];
  return lines
    .slice(sepIdx + 1)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('('));
}

// ── Internal ─────────────────────────────────────────────────────────────────

/** Extracts the first UUID-shaped string from psql output. */
function extractUUID(psqlOutput: string): string | null {
  const match = psqlOutput.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : null;
}
