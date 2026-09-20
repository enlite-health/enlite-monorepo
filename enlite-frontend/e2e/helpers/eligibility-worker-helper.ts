/**
 * eligibility-worker-helper.ts
 *
 * DB helpers for postularse-incomplete-modal integration tests.
 *
 * Provides fine-grained control over which worker fields/satellite rows are
 * populated so the backend fn_worker_missing_fields() returns a predictable
 * missingFields array. Kept separate from db-test-helper.ts to respect the
 * 400-line limit.
 *
 * Encoding: PII is base64-encoded (KMSEncryptionService test mode:
 * USE_KMS_ENCRYPTION=false / NODE_ENV=test — decrypt() just decodes base64).
 */

import { execSync } from 'child_process';

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

// ── Internal ──────────────────────────────────────────────────────────────────

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

function extractUUID(psqlOutput: string): string | null {
  const m = psqlOutput.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return m ? m[0] : null;
}

const enc = (v: string | null): string =>
  v == null ? 'NULL' : `'${Buffer.from(v, 'utf8').toString('base64')}'`;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Each flag controls whether that field/satellite row is populated.
 * Default: all fields present.
 * Pass false to omit a field so fn_worker_missing_fields() reports it missing.
 *
 * The worker is always inserted with status='INCOMPLETE_REGISTER' so
 * assertWorkerCanApply() always throws 403 and track-channel returns missingFields.
 */
export interface InsertEligibilityWorkerOpts {
  /**
   * Sets BOTH workers.profession (gate-checked by fn_worker_missing_fields /
   * fn_guard_registered_status) AND workers.occupation (display/matching field).
   * Both columns accept the same values and must be kept in sync.
   */
  occupation?: 'AT' | 'CAREGIVER' | null;
  firstName?: boolean;
  lastName?: boolean;
  sex?: boolean;
  gender?: boolean;
  birthDate?: boolean;
  documentNumber?: boolean;
  languages?: boolean;
  phone?: boolean;
  knowledgeLevel?: boolean;
  titleCertificate?: boolean;
  yearsExperience?: boolean;
  experienceTypes?: boolean;
  preferredTypes?: boolean;
  preferredAgeRange?: boolean;
  /** worker_service_areas row with address_line set (gate checks address_line IS NOT NULL) */
  serviceArea?: boolean;
  /** worker_availability row present */
  availability?: boolean;
  docResumeCv?: boolean;
  docIdentityDocument?: boolean;
  docCriminalRecord?: boolean;
  /** Only gate-required when occupation='AT' (or NULL, treated as AT) */
  docAtCertificate?: boolean;
}

export interface InsertEligibilityWorkerResult {
  workerId: string;
  /** auth_uid stored in workers.auth_uid — use to build the mock_<base64> token */
  authUid: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Inserts a test worker with fine-grained control over which fields/rows are
 * populated. Returns both the DB id and auth_uid.
 */
export function insertEligibilityWorker(
  opts: InsertEligibilityWorkerOpts = {},
): InsertEligibilityWorkerResult {
  const {
    occupation = 'AT',
    firstName = true,
    lastName = true,
    sex = true,
    gender = true,
    birthDate = true,
    documentNumber = true,
    languages = true,
    phone: hasPhone = true,
    knowledgeLevel = true,
    titleCertificate = true,
    yearsExperience = true,
    experienceTypes = true,
    preferredTypes = true,
    preferredAgeRange = true,
    serviceArea = true,
    availability = true,
    docResumeCv = true,
    docIdentityDocument = true,
    docCriminalRecord = true,
    docAtCertificate = true,
  } = opts;

  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const authUid = `e2e-postularse-${uniq}`;
  const email = `e2e.postularse.${uniq}@test.local`;
  const phoneVal = `+54911${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;

  // profession = gate column (fn_worker_missing_fields / fn_guard_registered_status)
  // occupation = display/matching column  — keep both in sync
  const professionSql = occupation ? `'${occupation}'` : 'NULL';

  // check_document_type_required: document_number_encrypted IS NULL OR document_type IS NOT NULL
  const documentTypeSql = documentNumber ? `'DNI'` : 'NULL';

  runSQL(`
    INSERT INTO workers (
      auth_uid, email, phone, status, country,
      profession, occupation,
      first_name_encrypted, last_name_encrypted, sex_encrypted,
      gender_encrypted, birth_date_encrypted, document_number_encrypted,
      document_type, languages_encrypted,
      knowledge_level, title_certificate, years_experience,
      experience_types, preferred_types, preferred_age_range,
      created_at, updated_at
    ) VALUES (
      '${authUid}', '${email}',
      ${hasPhone ? `'${phoneVal}'` : 'NULL'},
      'INCOMPLETE_REGISTER', 'AR',
      ${professionSql}, ${professionSql},
      ${firstName ? enc('TestNombre') : 'NULL'},
      ${lastName ? enc('TestApellido') : 'NULL'},
      ${sex ? enc('F') : 'NULL'},
      ${gender ? enc('female') : 'NULL'},
      ${birthDate ? enc('1990-01-01') : 'NULL'},
      ${documentNumber ? enc('12345678') : 'NULL'},
      ${documentTypeSql},
      ${languages ? enc('["ES"]') : 'NULL'},
      ${knowledgeLevel ? `'INTERMEDIATE'` : 'NULL'},
      ${titleCertificate ? `'AT_CERT'` : 'NULL'},
      ${yearsExperience ? `'3'` : 'NULL'},
      ${experienceTypes ? `ARRAY['TEA','MOTORA']::varchar[]` : 'NULL'},
      ${preferredTypes ? `ARRAY['DOMICILIARY']::varchar[]` : 'NULL'},
      ${preferredAgeRange ? `ARRAY['ADULT']::varchar[]` : 'NULL'},
      NOW(), NOW()
    )
  `);

  const idRow = runSQL(`SELECT id FROM workers WHERE auth_uid = '${authUid}'`);
  const workerId = extractUUID(idRow);
  if (!workerId) throw new Error(`Could not find worker after insert (auth_uid=${authUid})`);

  insertServiceArea(workerId, serviceArea);
  if (availability) insertAvailability(workerId);
  insertDocuments(workerId, { docResumeCv, docIdentityDocument, docCriminalRecord, docAtCertificate });

  return { workerId, authUid };
}

function insertServiceArea(workerId: string, withAddressLine: boolean): void {
  if (withAddressLine) {
    runSQL(`
      INSERT INTO worker_service_areas (
        worker_id, country, address_line, latitude, longitude, radius_km, created_at, updated_at
      ) VALUES (
        '${workerId}', 'AR', 'Av. Corrientes 1234, CABA', -34.6037, -58.3816, 20, NOW(), NOW()
      )
    `);
  } else {
    // Row exists but address_line IS NULL — fn_worker_missing_fields flags worker_service_areas
    runSQL(`
      INSERT INTO worker_service_areas (
        worker_id, country, latitude, longitude, radius_km, created_at, updated_at
      ) VALUES ('${workerId}', 'AR', NULL, NULL, 20, NOW(), NOW())
    `);
  }
}

function insertAvailability(workerId: string): void {
  runSQL(`
    INSERT INTO worker_availability (
      worker_id, day_of_week, start_time, end_time, timezone, created_at, updated_at
    ) VALUES ('${workerId}', 1, '09:00', '17:00', 'America/Argentina/Buenos_Aires', NOW(), NOW())
  `);
}

function insertDocuments(
  workerId: string,
  docs: {
    docResumeCv: boolean;
    docIdentityDocument: boolean;
    docCriminalRecord: boolean;
    docAtCertificate: boolean;
  },
): void {
  const { docResumeCv, docIdentityDocument, docCriminalRecord, docAtCertificate } = docs;
  const anyDoc = docResumeCv || docIdentityDocument || docCriminalRecord || docAtCertificate;
  if (!anyDoc) return;
  runSQL(`
    INSERT INTO worker_documents (
      worker_id, resume_cv_url, identity_document_url, criminal_record_url, at_certificate_url,
      documents_status, created_at, updated_at
    ) VALUES (
      '${workerId}',
      ${docResumeCv ? `'https://storage.example.com/resume.pdf'` : 'NULL'},
      ${docIdentityDocument ? `'https://storage.example.com/identity.pdf'` : 'NULL'},
      ${docCriminalRecord ? `'https://storage.example.com/criminal.pdf'` : 'NULL'},
      ${docAtCertificate ? `'https://storage.example.com/at_cert.pdf'` : 'NULL'},
      'submitted', NOW(), NOW()
    )
  `);
}

/**
 * Inserts a minimal job_posting (with patient + address) for postularse tests.
 * The vacancy has is_draft=false and status='SEARCHING' so track-channel does
 * not fail before reaching the eligibility gate.
 *
 * `includeInPublicListing`: also sets `social_short_links->'site'` — the LIST
 * endpoint (GET /api/public/v1/jobs, JobPostingARRepository.findActivePublic)
 * filters on `social_short_links ? 'site'` (PublicJobsQueryBuilder.ts), which
 * a bare insertMinimalVacancy() does NOT satisfy (the vacancy is still
 * fetchable by id via GET /api/vacancies/:id, just invisible in the list).
 *
 * Returns the job posting UUID.
 */
export function insertMinimalVacancy(
  opts: { talentumWhatsappUrl?: string; includeInPublicListing?: boolean } = {},
): string {
  const { talentumWhatsappUrl = 'https://wa.me/5491100000001', includeInPublicListing = false } = opts;

  const clickupTaskId = `E2E-POS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  runSQL(`
    INSERT INTO patients (
      clickup_task_id, first_name, last_name, status,
      diagnosis, dependency_level, country, created_at, updated_at
    ) VALUES (
      '${clickupTaskId}', 'PostularseTest', 'Patient', 'ACTIVE',
      'TEA', 'MODERATE', 'AR', NOW(), NOW()
    )
  `);
  const patientId = extractUUID(
    runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`),
  );
  if (!patientId) throw new Error('Could not insert test patient for vacancy');

  runSQL(`
    INSERT INTO patient_addresses (
      patient_id, address_formatted, address_raw,
      lat, lng, display_order, source, created_at, updated_at
    ) VALUES (
      '${patientId}', 'Av. Test 1234, CABA', 'Av. Test 1234, CABA',
      -34.6037, -58.3816, 1, 'manual', NOW(), NOW()
    )
  `);
  const patientAddressId = extractUUID(
    runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`),
  );
  if (!patientAddressId) throw new Error('Could not insert test patient address');

  const caseNum = Math.floor(Math.random() * 90000) + 10000;
  runSQL(`
    INSERT INTO job_postings (
      vacancy_number, case_number, title, description,
      patient_id, patient_address_id,
      required_professions, providers_needed,
      status, is_draft, country,
      talentum_whatsapp_url, social_short_links,
      created_at, updated_at
    ) VALUES (
      nextval('job_postings_vacancy_number_seq'), ${caseNum},
      'CASO ${caseNum} Test', '',
      '${patientId}', '${patientAddressId}',
      ARRAY['AT']::varchar[], 1,
      'SEARCHING', false, 'AR',
      '${talentumWhatsappUrl}',
      ${includeInPublicListing ? `'{"site": "https://jobs.enlite.health/es/vagas/${caseNum}/"}'::jsonb` : 'NULL'},
      NOW(), NOW()
    )
  `);

  const vacancyId = extractUUID(
    runSQL(
      `SELECT id FROM job_postings WHERE patient_id = '${patientId}' ORDER BY created_at DESC LIMIT 1`,
    ),
  );
  if (!vacancyId) throw new Error('Could not find inserted vacancy');
  return vacancyId;
}

/** Cleans up a vacancy and its associated patient/address. */
export function cleanupMinimalVacancy(vacancyId: string): void {
  if (!vacancyId) return;
  const patientId = extractUUID(
    runSQL(`SELECT patient_id FROM job_postings WHERE id = '${vacancyId}'`),
  );
  runSQL(`DELETE FROM worker_blocked_applications WHERE job_posting_id = '${vacancyId}'`);
  runSQL(`DELETE FROM worker_job_applications WHERE job_posting_id = '${vacancyId}'`);
  runSQL(`DELETE FROM encuadres WHERE job_posting_id = '${vacancyId}'`);
  runSQL(`DELETE FROM job_postings WHERE id = '${vacancyId}'`);
  if (patientId) {
    // Migration 330: serviço contratado aponta para o endereço (FK) — sai antes do endereço.
    runSQL(`DELETE FROM patient_contracted_services WHERE patient_id = '${patientId}'`);
    runSQL(`DELETE FROM patient_addresses WHERE patient_id = '${patientId}'`);
    runSQL(`DELETE FROM patients WHERE id = '${patientId}'`);
  }
}

/**
 * Reads back the most recent worker_blocked_applications row's
 * acquisition_channel for a worker+vacancy pair — the real Postgres proof
 * that a blocked Postularse click (home vagas API pública, canal fixo
 * 'site') was actually instrumented, not just that the modal showed.
 * Returns null if no blocked-attempt row exists — AND ALSO if a row exists
 * with acquisition_channel NULL (both collapse to '' at the SQL layer via
 * COALESCE). Fine for this helper's purpose (asserting `=== 'site'`, where
 * both cases must equally fail); do not reuse this to distinguish "no row"
 * from "row with null channel" without adding a row-existence check first.
 *
 * `-t -A -F'|'` (tuples only, unaligned, pipe-separated): acquisition_channel
 * is free text — regexing it out of the default aligned table output (like
 * extractUUID does for UUIDs) would be fragile.
 */
export function getBlockedApplicationChannel(workerId: string, jobPostingId: string): string | null {
  const sql = `SELECT COALESCE(acquisition_channel, '') FROM worker_blocked_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}' ORDER BY created_at DESC LIMIT 1`;
  const escaped = sql.replace(/'/g, "'\\''");
  let out: string;
  try {
    out = execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -F'|' -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString().trim();
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    throw new Error(`DB error: ${e.message}`);
  }
  return out === '' ? null : out;
}

/** Resolves a worker's DB id from its auth_uid (workers provisioned via the real UI). */
export function resolveWorkerIdByAuthUid(authUid: string): string | null {
  if (!authUid) return null;
  return extractUUID(runSQL(`SELECT id FROM workers WHERE auth_uid = '${authUid}'`));
}

/**
 * Forces a worker's status. Used by the WhatsApp-gate integration tests to
 * exercise DISABLED (blocked) and REGISTERED (eligible) branches of the real
 * backend eligibility gate. Note: setting REGISTERED only sticks if
 * fn_guard_registered_status is satisfied (all required fields present);
 * assert with getWorkerStatusByAuthUid afterwards.
 */
export function setWorkerStatus(
  workerId: string,
  status: 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED',
): void {
  if (!workerId) return;
  runSQL(`UPDATE workers SET status = '${status}', updated_at = NOW() WHERE id = '${workerId}'`);
}

/** Reads a worker's status by auth_uid (e.g. to assert REGISTERED after a real journey). */
export function getWorkerStatusByAuthUid(authUid: string): string | null {
  if (!authUid) return null;
  const out = runSQL(`SELECT status FROM workers WHERE auth_uid = '${authUid}'`);
  const m = out.match(/\b(REGISTERED|INCOMPLETE_REGISTER|DISABLED)\b/);
  return m ? m[1] : null;
}

/**
 * Reads `workers.years_experience` straight from the DB.
 *
 * A profile assertion MUST NOT be made by reloading the page: the Zustand store
 * is persisted to localStorage, so the field would render filled even if the
 * PUT never left the browser — exactly the bug this reads for. The database is
 * the only honest oracle here.
 */
export function getWorkerYearsExperience(workerId: string): string | null {
  if (!workerId) return null;
  const out = runSQL(`SELECT years_experience FROM workers WHERE id = '${workerId}'`);
  const m = out.match(/\b(0_2|3_5|6_10|10_plus)\b/);
  return m ? m[1] : null;
}

/** Full cleanup for a worker provisioned via the real UI (resolved by auth_uid). */
export function cleanupWorkerByAuthUid(authUid: string): void {
  const workerId = resolveWorkerIdByAuthUid(authUid);
  if (workerId) cleanupEligibilityWorker(workerId);
}

/** Full cleanup for a worker created by insertEligibilityWorker. */
export function cleanupEligibilityWorker(workerId: string): void {
  if (!workerId) return;
  runSQL(`DELETE FROM worker_blocked_applications WHERE worker_id = '${workerId}'`);
  runSQL(`DELETE FROM worker_job_applications WHERE worker_id = '${workerId}'`);
  runSQL(`DELETE FROM encuadres WHERE worker_id = '${workerId}'`);
  runSQL(`DELETE FROM worker_documents WHERE worker_id = '${workerId}'`);
  runSQL(`DELETE FROM worker_availability WHERE worker_id = '${workerId}'`);
  runSQL(`DELETE FROM worker_service_areas WHERE worker_id = '${workerId}'`);
  runSQL(`DELETE FROM workers WHERE id = '${workerId}'`);
}
