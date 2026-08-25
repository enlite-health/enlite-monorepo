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
import { decidirColunas } from './export/workerExportCells';
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
  /**
   * Células do ator (C5). `null` = o engine não decidiu nesta request → nada
   * muda (D113). **Nunca `[]` por omissão**: `[]` derruba o dossiê inteiro.
   */
  cells: string[] | null;
}

/**
 * Toda coluna pedida caiu no gate. É 403, e não planilha vazia: arquivo vazio
 * parece cadastro vazio, e a pessoa vai procurar o defeito no lugar errado.
 */
export class ExportSemColunaPermitidaError extends Error {
  constructor(public readonly negadas: WorkerExportColumnKey[]) {
    super(`Nenhuma coluna permitida: ${negadas.join(', ')} exigem worker_pii:read`);
    this.name = 'ExportSemColunaPermitidaError';
  }
}

export type CsvLineEmitter = (line: string) => void;

export interface ExportWorkersResult {
  format: 'csv' | 'xlsx';
  /** Colunas tiradas pelo gate da C5 — o chamador TEM de avisar quem pediu. */
  negadas: WorkerExportColumnKey[];
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

/**
 * Cada coluna cifrada e a cifra de onde ela sai. É esta tabela que permite
 * descriptografar SÓ o que a coluna pede.
 */
const CIFRA_DA_COLUNA = {
  first_name: 'first_name_encrypted',
  last_name: 'last_name_encrypted',
  gender: 'gender_encrypted',
  sex: 'sex_encrypted',
  birth_date: 'birth_date_encrypted',
  document_number: 'document_number_encrypted',
  languages: 'languages_encrypted',
  sexual_orientation: 'sexual_orientation_encrypted',
  race: 'race_encrypted',
  religion: 'religion_encrypted',
  weight_kg: 'weight_kg_encrypted',
  height_cm: 'height_cm_encrypted',
  whatsapp_phone: 'whatsapp_phone_encrypted',
  linkedin_url: 'linkedin_url_encrypted',
} as const satisfies Partial<Record<WorkerExportColumnKey, keyof WorkerDbRow>>;

type ColunaCifrada = keyof typeof CIFRA_DA_COLUNA;

/**
 * Descriptografa APENAS as colunas pedidas.
 *
 * ⚠️ Antes da C5 este `Promise.all` abria os 14 campos SEMPRE — exportar só
 * `status` descriptografava DNI, raça, religião e orientação sexual, e jogava
 * fora. Texto claro que existiu em memória e pôde cair num log de erro do KMS
 * para quem nunca pediu aquele dado. É o mesmo defeito da C3, noutra rota: a
 * decisão tem de vir ANTES do KMS, não depois.
 *
 * A prova disso é o espião com a CONTAGEM esperada, não a leitura do código.
 */
async function decryptRow(
  kms: KMSEncryptionService,
  row: WorkerDbRow,
  colunas: readonly WorkerExportColumnKey[],
): Promise<PlaintextWorker> {
  const pedidas = new Set<string>(colunas);
  const abertos = {} as Record<ColunaCifrada, string>;

  const chaves = (Object.keys(CIFRA_DA_COLUNA) as ColunaCifrada[]).filter((c) => pedidas.has(c));
  const valores = await Promise.all(
    chaves.map((c) => {
      const campo = CIFRA_DA_COLUNA[c];
      return safeDecrypt(kms, row[campo] as string | null, row.id, campo);
    }),
  );
  chaves.forEach((c, i) => { abertos[c] = valores[i]; });

  // Coluna não pedida sai como string vazia — o chamador nunca a lê, e um
  // `undefined` aqui viraria "undefined" no CSV se alguém errasse a seleção.
  const abrir = (c: ColunaCifrada): string => abertos[c] ?? '';
  const firstName = abrir('first_name');
  const lastName = abrir('last_name');
  const gender = abrir('gender');
  const sex = abrir('sex');
  const birthDate = abrir('birth_date');
  const documentNumber = abrir('document_number');
  const languages = abrir('languages');
  const sexualOrientation = abrir('sexual_orientation');
  const race = abrir('race');
  const religion = abrir('religion');
  const weightKg = abrir('weight_kg');
  const heightCm = abrir('height_cm');
  const whatsappPhone = abrir('whatsapp_phone');
  const linkedinUrl = abrir('linkedin_url');

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
    const { format, filters } = input;
    // C5: a célula decide as colunas ANTES da query e ANTES do KMS. O que for
    // negado nem chega a ser descriptografado — negar depois seria esconder da
    // planilha, não proteger o dado.
    const { permitidas: columns, negadas } = decidirColunas(input.cells, input.columns);
    if (columns.length === 0) {
      throw new ExportSemColunaPermitidaError(negadas);
    }
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
      return { format: 'csv', negadas, csvLines: this.streamCsvLines(rows, columns) };
    }

    // XLSX — buffer in memory
    const xlsxBuffer = await this.buildXlsx(rows, columns);
    return { format: 'xlsx', negadas, xlsxBuffer };
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
      const decrypted = await Promise.all(chunk.map((row) => decryptRow(this.kms, row, columns)));

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
      const decrypted = await Promise.all(chunk.map((row) => decryptRow(this.kms, row, columns)));

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
