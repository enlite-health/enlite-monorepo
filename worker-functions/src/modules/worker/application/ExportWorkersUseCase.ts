/**
 * ExportWorkersUseCase.ts
 *
 * Exports workers to CSV (streaming) or XLSX (buffer) with optional filters
 * and per-column selection. PII fields are decrypted via KMSEncryptionService.
 *
 * Decrypt parallelism: workers are processed in chunks of DECRYPT_CHUNK_SIZE.
 * Within each chunk all workers are decrypted concurrently; across chunks they
 * are processed sequentially to avoid flooding the KMS API.
 *
 * // Acima de ~10k workers, considerar migrar para job em background.
 */

import { Pool } from 'pg';
import * as XLSX from 'xlsx';
import { Readable } from 'stream';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { WorkerExportColumnKey, COLUMN_LABELS_ES } from './export/workerExportColumns';
import { csvRow } from './export/csvUtils';
import { buildAllValidatedClause, buildPendingValidationClause } from './workerDocumentFilters';

// ── Constants ────────────────────────────────────────────────────────────────

const DECRYPT_CHUNK_SIZE = 25;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExportWorkersFilters {
  status?: string;
  platform?: string;
  docs_complete?: string;
  docs_validated?: 'all_validated' | 'pending_validation';
  case_id?: string;
}

export interface ExportWorkersInput {
  format: 'csv' | 'xlsx';
  columns: WorkerExportColumnKey[];
  filters: ExportWorkersFilters;
}

export type CsvLineEmitter = (line: string) => void;

export interface ExportWorkersResult {
  format: 'csv' | 'xlsx';
  /** Present only for XLSX — full buffer ready to send. */
  xlsxBuffer?: Buffer;
  /** Present only for CSV — async generator yielding one CRLF-terminated line at a time. */
  csvLines?: AsyncGenerator<string>;
}

// ── Helpers: safe decrypt ─────────────────────────────────────────────────────

async function safeDecrypt(
  kms: KMSEncryptionService,
  ciphertext: string | null | undefined,
  workerId: string,
  fieldName: string,
): Promise<string> {
  if (!ciphertext) return '';
  try {
    return await kms.decrypt(ciphertext);
  } catch (err: any) {
    console.warn(`[ExportWorkersUseCase] worker ${workerId} — decrypt failed for ${fieldName}: ${err.message}`);
    return '';
  }
}

// ── Helpers: map DB row to plaintext record ───────────────────────────────────

interface WorkerDbRow {
  id: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  status: string | null;
  document_type: string | null;
  profession: string | null;
  occupation: string | null;
  knowledge_level: string | null;
  title_certificate: string | null;
  years_experience: string | null;
  experience_types: string[] | null;
  preferred_types: string[] | null;
  preferred_age_range: string[] | null;
  hobbies: string[] | null;
  diagnostic_preferences: string[] | null;
  created_at: Date | null;
  // address from LEFT JOIN worker_service_areas
  address_line: string | null;
  city: string | null;
  postal_code: string | null;
  // encrypted
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  gender_encrypted: string | null;
  sex_encrypted: string | null;
  birth_date_encrypted: string | null;
  document_number_encrypted: string | null;
  languages_encrypted: string | null;
  sexual_orientation_encrypted: string | null;
  race_encrypted: string | null;
  religion_encrypted: string | null;
  weight_kg_encrypted: string | null;
  height_cm_encrypted: string | null;
  whatsapp_phone_encrypted: string | null;
  linkedin_url_encrypted: string | null;
}

type PlaintextWorker = Record<WorkerExportColumnKey, string>;

async function decryptRow(
  kms: KMSEncryptionService,
  row: WorkerDbRow,
): Promise<PlaintextWorker> {
  const [
    firstName, lastName, gender, sex, birthDate, documentNumber,
    languages, sexualOrientation, race, religion, weightKg, heightCm,
    whatsappPhone, linkedinUrl,
  ] = await Promise.all([
    safeDecrypt(kms, row.first_name_encrypted, row.id, 'first_name_encrypted'),
    safeDecrypt(kms, row.last_name_encrypted, row.id, 'last_name_encrypted'),
    safeDecrypt(kms, row.gender_encrypted, row.id, 'gender_encrypted'),
    safeDecrypt(kms, row.sex_encrypted, row.id, 'sex_encrypted'),
    safeDecrypt(kms, row.birth_date_encrypted, row.id, 'birth_date_encrypted'),
    safeDecrypt(kms, row.document_number_encrypted, row.id, 'document_number_encrypted'),
    safeDecrypt(kms, row.languages_encrypted, row.id, 'languages_encrypted'),
    safeDecrypt(kms, row.sexual_orientation_encrypted, row.id, 'sexual_orientation_encrypted'),
    safeDecrypt(kms, row.race_encrypted, row.id, 'race_encrypted'),
    safeDecrypt(kms, row.religion_encrypted, row.id, 'religion_encrypted'),
    safeDecrypt(kms, row.weight_kg_encrypted, row.id, 'weight_kg_encrypted'),
    safeDecrypt(kms, row.height_cm_encrypted, row.id, 'height_cm_encrypted'),
    safeDecrypt(kms, row.whatsapp_phone_encrypted, row.id, 'whatsapp_phone_encrypted'),
    safeDecrypt(kms, row.linkedin_url_encrypted, row.id, 'linkedin_url_encrypted'),
  ]);

  return {
    first_name: firstName,
    last_name: lastName,
    email: row.email ?? '',
    phone: row.phone ?? '',
    gender,
    sex,
    birth_date: birthDate,
    document_type: row.document_type ?? '',
    document_number: documentNumber,
    profession: row.profession ?? '',
    occupation: row.occupation ?? '',
    knowledge_level: row.knowledge_level ?? '',
    title_certificate: row.title_certificate ?? '',
    years_experience: row.years_experience ?? '',
    experience_types: (row.experience_types ?? []).join(';'),
    preferred_types: (row.preferred_types ?? []).join(';'),
    preferred_age_range: (row.preferred_age_range ?? []).join(';'),
    hobbies: (row.hobbies ?? []).join(';'),
    diagnostic_preferences: (row.diagnostic_preferences ?? []).join(';'),
    languages,
    sexual_orientation: sexualOrientation,
    race,
    religion,
    weight_kg: weightKg,
    height_cm: heightCm,
    whatsapp_phone: whatsappPhone,
    linkedin_url: linkedinUrl,
    address_line: row.address_line ?? '',
    city: row.city ?? '',
    postal_code: row.postal_code ?? '',
    country: row.country ?? '',
    status: row.status ?? '',
    created_at: row.created_at ? row.created_at.toISOString() : '',
  };
}

// ── WHERE clause builder (mirrors listWorkers logic) ─────────────────────────

function buildExportWhere(filters: ExportWorkersFilters): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  let idx = 1;
  let clause = 'WHERE w.merged_into_id IS NULL';

  // Mesma regra da lista: status explícito manda (inclusive DISABLED); sem
  // filtro, quem deu baixa na conta não sai no export. Ver activeWorkerFilter.
  if (filters.status) {
    clause += ` AND w.status = $${idx++}`;
    params.push(filters.status);
  } else {
    clause += ` AND ${excludeDisabledWorkersSql('w')}`;
  }

  if (filters.platform) {
    if (filters.platform === 'talentum') {
      clause += ` AND (w.data_sources && ARRAY['candidatos', 'candidatos_no_terminaron']::text[])`;
    } else if (filters.platform === 'enlite_app') {
      clause += ` AND (w.data_sources IS NULL OR w.data_sources = '{}')`;
    } else {
      clause += ` AND ($${idx++} = ANY(w.data_sources))`;
      params.push(filters.platform);
    }
  }

  if (filters.docs_complete === 'complete') {
    clause += ` AND w.status = 'REGISTERED'`;
  } else if (filters.docs_complete === 'incomplete') {
    clause += ` AND w.status = 'INCOMPLETE_REGISTER'`;
  }

  if (filters.docs_validated === 'all_validated') {
    clause += ` AND ${buildAllValidatedClause('wd')}`;
  } else if (filters.docs_validated === 'pending_validation') {
    clause += ` AND ${buildPendingValidationClause('wd')}`;
  }

  if (filters.case_id) {
    clause += ` AND EXISTS (SELECT 1 FROM encuadres e2 WHERE e2.worker_id = w.id AND e2.job_posting_id = $${idx++})`;
    params.push(filters.case_id);
  }

  return { clause, params };
}

// ── Use case ─────────────────────────────────────────────────────────────────

export class ExportWorkersUseCase {
  private db: Pool;
  private kms: KMSEncryptionService;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.kms = new KMSEncryptionService();
  }

  async execute(input: ExportWorkersInput): Promise<ExportWorkersResult> {
    const { format, columns, filters } = input;
    const { clause, params } = buildExportWhere(filters);

    const query = `
      SELECT DISTINCT ON (w.id)
        w.id, w.email, w.phone, w.country, w.status,
        w.document_type, w.profession, w.occupation, w.knowledge_level,
        w.title_certificate, w.years_experience, w.experience_types,
        w.preferred_types, w.preferred_age_range, w.hobbies,
        w.diagnostic_preferences, w.created_at,
        w.first_name_encrypted, w.last_name_encrypted, w.gender_encrypted,
        w.sex_encrypted, w.birth_date_encrypted, w.document_number_encrypted,
        w.languages_encrypted, w.sexual_orientation_encrypted, w.race_encrypted,
        w.religion_encrypted, w.weight_kg_encrypted, w.height_cm_encrypted,
        w.whatsapp_phone_encrypted, w.linkedin_url_encrypted,
        sa.address_line, sa.city, sa.postal_code
      FROM workers w
      LEFT JOIN worker_documents wd ON wd.worker_id = w.id
      LEFT JOIN worker_service_areas sa ON sa.worker_id = w.id
      ${clause}
      ORDER BY w.id, sa.created_at DESC NULLS LAST
    `;

    const result = await this.db.query<WorkerDbRow>(query, params);
    const rows = result.rows;

    if (format === 'csv') {
      return { format: 'csv', csvLines: this.streamCsvLines(rows, columns) };
    }

    // XLSX — buffer in memory
    const xlsxBuffer = await this.buildXlsx(rows, columns);
    return { format: 'xlsx', xlsxBuffer };
  }

  // ── CSV streaming ─────────────────────────────────────────────────

  private async *streamCsvLines(
    rows: WorkerDbRow[],
    columns: WorkerExportColumnKey[],
  ): AsyncGenerator<string> {
    // Header line — use translated labels (ES-AR) instead of raw DB keys
    yield csvRow(columns.map((c) => COLUMN_LABELS_ES[c])) + '\r\n';

    // Process in chunks of DECRYPT_CHUNK_SIZE
    for (let i = 0; i < rows.length; i += DECRYPT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + DECRYPT_CHUNK_SIZE);
      const decrypted = await Promise.all(chunk.map((row) => decryptRow(this.kms, row)));

      for (const record of decrypted) {
        yield csvRow(columns.map((col) => record[col])) + '\r\n';
      }
    }
  }

  // ── XLSX buffer ───────────────────────────────────────────────────

  private async buildXlsx(
    rows: WorkerDbRow[],
    columns: WorkerExportColumnKey[],
  ): Promise<Buffer> {
    const data: string[][] = [columns.map((c) => COLUMN_LABELS_ES[c])]; // header row — translated labels (ES-AR)

    for (let i = 0; i < rows.length; i += DECRYPT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + DECRYPT_CHUNK_SIZE);
      const decrypted = await Promise.all(chunk.map((row) => decryptRow(this.kms, row)));

      for (const record of decrypted) {
        data.push(columns.map((col) => record[col]));
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Workers');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
}
