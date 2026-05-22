/**
 * db-patient-clickup-helper.ts
 *
 * DB helpers específicos para testes de sincronização ClickUp → patient.
 * Usa o mesmo padrão de `docker exec enlite-postgres psql` do db-test-helper.ts.
 *
 * Separado de db-test-helper.ts para manter o arquivo principal abaixo de 400 linhas.
 */

import { execSync } from 'child_process';

// ── Constants ──────────────────────────────────────────────────────────────────

const CONTAINER = 'enlite-postgres';
const DB_USER   = 'enlite_admin';
const DB_NAME   = 'enlite_e2e';

// ── Internal ───────────────────────────────────────────────────────────────────

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message}`);
  }
}

function parseSingleRow(out: string): string[] | null {
  const lines  = out.split('\n').filter((l) => l.trim());
  const sepIdx = lines.findIndex((l) => l.startsWith('-'));
  if (sepIdx === -1) return null;
  const dataLine = lines[sepIdx + 1];
  if (!dataLine || dataLine.includes('(0 rows)')) return null;
  return dataLine.split('|').map((s) => s.trim());
}

// ── Public types ───────────────────────────────────────────────────────────────

export interface PatientRow {
  id: string;
  first_name: string;
  last_name: string;
  status: string | null;
  case_number: string | null;
}

export interface HealthInsuranceRow {
  provider_name: string | null;
  plan: string | null;
  member_id: string | null;
  emergency_numbers: string | null;
  source: string | null;
}

export interface PatientAddressRow {
  id: string;
  address_formatted: string | null;
  address_type: string | null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Busca um paciente pelo clickup_task_id. Retorna null quando não encontrado.
 * O sync via UseCase é síncrono, mas pode haver latência de rede no Docker.
 */
export function getPatientByClickUpTaskId(clickupTaskId: string): PatientRow | null {
  const out = runSQL(
    `SELECT id, first_name, last_name, status, case_number
     FROM patients
     WHERE clickup_task_id = '${clickupTaskId}'
       AND deleted_at IS NULL
     LIMIT 1`,
  );
  const parts = parseSingleRow(out);
  if (!parts) return null;
  return {
    id:          parts[0] ?? '',
    first_name:  parts[1] ?? '',
    last_name:   parts[2] ?? '',
    status:      parts[3] || null,
    case_number: parts[4] || null,
  };
}

/**
 * Busca o row de patient_health_insurance para um patient_id.
 * Retorna null quando o row ainda não existe.
 *
 * Semântica fill-only: o upsert do ClickUp nunca sobrescreve provider_name
 * já preenchido — esse helper permite validar essa invariante nos testes.
 */
export function getPatientHealthInsurance(patientId: string): HealthInsuranceRow | null {
  const out = runSQL(
    `SELECT provider_name, plan, member_id, emergency_numbers::text, source
     FROM patient_health_insurance
     WHERE patient_id = '${patientId}'
     LIMIT 1`,
  );
  const parts = parseSingleRow(out);
  if (!parts) return null;
  return {
    provider_name:     parts[0] || null,
    plan:              parts[1] || null,
    member_id:         parts[2] || null,
    emergency_numbers: parts[3] || null,
    source:            parts[4] || null,
  };
}

/**
 * Busca todos os endereços de um paciente ordenados por display_order.
 */
export function getPatientAddressRows(patientId: string): PatientAddressRow[] {
  const out = runSQL(
    `SELECT id, address_formatted, address_type
     FROM patient_addresses
     WHERE patient_id = '${patientId}'
     ORDER BY display_order ASC`,
  );
  const lines  = out.split('\n').filter((l) => l.trim());
  const sepIdx = lines.findIndex((l) => l.startsWith('-'));
  if (sepIdx === -1) return [];
  return lines
    .slice(sepIdx + 1)
    .filter((l) => l.trim() && !l.trim().startsWith('('))
    .map((l) => {
      const parts = l.split('|').map((s) => s.trim());
      return {
        id:                parts[0] ?? '',
        address_formatted: parts[1] || null,
        address_type:      parts[2] || null,
      };
    });
}

/**
 * Remove o paciente e todos os registros dependentes (cascata via FK ON DELETE CASCADE,
 * mas patient_health_insurance pode não ter CASCADE — deletamos explicitamente).
 * Seguro chamar mesmo que o paciente não exista.
 */
export function cleanupTestPatientFull(patientId: string): void {
  if (!patientId || patientId === 'undefined') return;
  runSQL(`DELETE FROM patient_health_insurance WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM patient_addresses        WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM patient_responsibles     WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM job_postings             WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM patients                WHERE id          = '${patientId}'`);
}
