/**
 * patient-addresses-test-helper.ts
 *
 * Direct DB helpers for patient_addresses operations used by integration E2E
 * tests. Extracted from db-test-helper.ts to keep that file within the
 * 400-line limit.
 *
 * Uses `docker exec enlite-postgres psql` for the same zero-frontend-deps
 * approach as the parent helper.
 */

import { execSync } from 'child_process';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

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
  const match = psqlOutput.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : null;
}

export interface InsertSecondAddressOpts {
  patientId: string;
  addressFormatted: string;
  addressLat?: number;
  addressLng?: number;
  displayOrder?: number;
}

/**
 * Inserts an additional patient_address for an existing patient. Used by tests
 * that need a patient with multiple active addresses (display_order 1 + 2).
 * Spec 019/migration 434: `address_type` nasce NULL — nenhum teste que usa este
 * helper asserta sobre o valor do tipo, só sobre existir um 2º endereço ativo.
 */
export function insertSecondAddress(opts: InsertSecondAddressOpts): string {
  const {
    patientId,
    addressFormatted,
    addressLat = -34.55,
    addressLng = -58.55,
    displayOrder = 2,
  } = opts;

  runSQL(`
    INSERT INTO patient_addresses (
      patient_id, address_formatted, address_raw,
      lat, lng, display_order, source, created_at, updated_at
    ) VALUES (
      '${patientId}',
      '${addressFormatted.replace(/'/g, "''")}',
      '${addressFormatted.replace(/'/g, "''")}',
      ${addressLat},
      ${addressLng},
      ${displayOrder},
      'manual',
      NOW(), NOW()
    )
  `);

  const row = runSQL(
    `SELECT id FROM patient_addresses
      WHERE patient_id = '${patientId}'
        AND display_order = ${displayOrder}
        AND archived_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  );
  const id = extractUUID(row);
  if (!id) throw new Error(`Could not find second address for patient ${patientId}`);
  return id;
}

/** Marks a patient_address as archived (simulates ClickUp versioning). */
export function archivePatientAddress(addressId: string): void {
  runSQL(`UPDATE patient_addresses SET archived_at = NOW() WHERE id = '${addressId}'`);
}

/**
 * Sets the case_number on an existing patient. Needed because
 * /api/admin/vacancies/cases-for-select filters by `p.case_number IS NOT NULL`,
 * and insertTestPatient does not seed a case_number.
 */
export function setPatientCaseNumber(patientId: string, caseNumber: number): void {
  runSQL(`UPDATE patients SET case_number = ${caseNumber} WHERE id = '${patientId}'`);
}

export interface InsertOperationalVacancyOpts {
  patientId: string;
  patientAddressId: string;
  caseNumber: number;
  status?: string;
  isDraft?: boolean;
}

/**
 * Inserts a job_posting that simulates an already-PUBLISHED vacancy
 * (status = 'SEARCHING', is_draft = false). Used to test the
 * AddressHasVacancyDialog guard that surfaces when the operator picks an
 * address that is already attached to a live vacancy.
 */
export function insertOperationalVacancy(opts: InsertOperationalVacancyOpts): string {
  const {
    patientId,
    patientAddressId,
    caseNumber,
    status = 'SEARCHING',
    isDraft = false,
  } = opts;

  runSQL(`
    INSERT INTO job_postings (
      vacancy_number, case_number, title, description,
      patient_id, patient_address_id,
      required_professions, providers_needed,
      status, is_draft, country, created_at, updated_at
    ) VALUES (
      nextval('job_postings_vacancy_number_seq'),
      ${caseNumber},
      'CASO ${caseNumber}-op',
      '',
      '${patientId}',
      '${patientAddressId}',
      ARRAY['AT']::varchar[],
      1,
      '${status}',
      ${isDraft},
      'AR',
      NOW(), NOW()
    )
  `);

  const idRow = runSQL(
    `SELECT id FROM job_postings
      WHERE patient_id = '${patientId}' AND case_number = ${caseNumber}
      ORDER BY created_at DESC LIMIT 1`,
  );
  const id = extractUUID(idRow);
  if (!id) throw new Error(`Could not find operational vacancy for patient ${patientId}`);
  return id;
}
