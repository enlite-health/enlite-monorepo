/**
 * WorkerImportRepository
 *
 * Extracted from WorkerRepository to stay within the 400-line limit.
 * Contains methods used exclusively by import scripts and status recalculation:
 *   - findByCuit
 *   - updateFromImport
 *   - addDataSource
 *   - recalculateStatus (delegated from WorkerRepository)
 */

import { Pool } from 'pg';
import { Worker, WorkerStatus } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';

export async function findByCuit(pool: Pool, cuit: string): Promise<Result<Worker | null>> {
  try {
    const digits = cuit.replace(/\D/g, '');
    const result = await pool.query(
      `SELECT id, auth_uid as "authUid", email, phone, country,
              created_at as "createdAt", updated_at as "updatedAt"
       FROM workers
       WHERE replace(cuit, '-', '') = $1
         AND merged_into_id IS NULL`,
      [digits],
    );
    if (result.rows.length === 0) return Result.ok<Worker | null>(null);
    return Result.ok<Worker>(result.rows[0]);
  } catch (error: any) {
    return Result.fail<Worker | null>(`Failed to find worker by cuit: ${error.message}`);
  }
}

export type WorkerImportData = Partial<{
  firstName: string | null;
  lastName: string | null;
  birthDate: Date | null;
  sex: string | null;
  occupation: string | null;
  anaCareId: string | null;
  documentType: 'DNI' | 'CUIT' | 'PASSPORT' | null;
  documentNumber: string | null;
  phone: string | null;
  profession: string | null;
  linkedinUrl: string | null;
  branchOffice: string | null;
  /** Email real do worker — substituirá emails gerados (@enlite.import) automaticamente. */
  email: string | null;
}>;

export async function updateFromImport(
  pool: Pool,
  encryptionService: KMSEncryptionService,
  blindIndexService: BlindIndexService,
  workerId: string,
  data: WorkerImportData,
  recalcFn: (workerId: string) => Promise<WorkerStatus | null>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [workerId];
  let idx = 2;

  // Campos não-PII: escritos diretamente em plaintext
  const plainFieldMap: Record<string, string> = {
    occupation: 'occupation',
    anaCareId: 'ana_care_id',
    documentType: 'document_type',
    phone: 'phone',
    profession: 'profession',
    branchOffice: 'branch_office',
  };

  for (const [key, col] of Object.entries(plainFieldMap)) {
    if (key in data && data[key as keyof typeof data] !== undefined) {
      sets.push(`${col} = COALESCE($${idx++}, ${col})`);
      values.push(data[key as keyof typeof data]);
    }
  }

  // Email: atualiza APENAS se o valor recebido é um email real (não gerado)
  // e o email atual no banco é um email de importação (@enlite.import).
  if (data.email && !data.email.endsWith('@enlite.import')) {
    sets.push(`email = CASE WHEN email LIKE '%@enlite.import' THEN $${idx++} ELSE email END`);
    values.push(data.email);
  }

  // Campos PII: criptografar com KMS em BATCH (paralelo) para reduzir latência
  // COALESCE preserva o valor existente se o novo for null (não sobrescreve com null)
  const piiToEncrypt: Record<string, string> = {};
  const piiFieldMap: Array<{ key: keyof typeof data; col: string; batchKey: string }> = [
    { key: 'firstName',     col: 'first_name_encrypted',     batchKey: 'firstName' },
    { key: 'lastName',      col: 'last_name_encrypted',      batchKey: 'lastName' },
    { key: 'sex',           col: 'sex_encrypted',            batchKey: 'sex' },
    { key: 'documentNumber', col: 'document_number_encrypted', batchKey: 'documentNumber' },
    { key: 'linkedinUrl',   col: 'linkedin_url_encrypted',   batchKey: 'linkedinUrl' },
  ];

  // Coletar valores para criptografar em batch
  for (const { key, batchKey } of piiFieldMap) {
    const raw = data[key];
    if (raw !== undefined && raw !== null && raw !== '') {
      piiToEncrypt[batchKey] = String(raw);
    }
  }

  // birthDate: converter para string ISO antes de criptografar
  if (data.birthDate !== undefined && data.birthDate !== null) {
    const dateStr =
      data.birthDate instanceof Date
        ? data.birthDate.toISOString().split('T')[0]
        : String(data.birthDate);
    piiToEncrypt['birthDate'] = dateStr;
  }

  // Criptografar TODOS os campos PII em paralelo (1 batch ao invés de 6 chamadas sequenciais)
  if (Object.keys(piiToEncrypt).length > 0) {
    const startEncrypt = Date.now();
    const encrypted = await encryptionService.encryptBatch(piiToEncrypt);
    const encryptTime = Date.now() - startEncrypt;
    if (encryptTime > 100) {
      console.log(
        `[WorkerRepo] Batch encrypt ${Object.keys(piiToEncrypt).length} fields took ${encryptTime}ms`,
      );
    }

    // Adicionar valores criptografados ao UPDATE
    for (const { key, col, batchKey } of piiFieldMap) {
      if (batchKey in encrypted && encrypted[batchKey] !== null) {
        sets.push(`${col} = COALESCE($${idx++}, ${col})`);
        values.push(encrypted[batchKey]);
      }
    }

    // birthDate
    if ('birthDate' in encrypted && encrypted.birthDate !== null) {
      sets.push(`birth_date_encrypted = COALESCE($${idx++}, birth_date_encrypted)`);
      values.push(encrypted.birthDate);
    }
  }

  // Blind index: recalculate name_trgm_bidx if firstName or lastName changed.
  // When only one arrives, fetch the current value to compose the full name.
  const nameChanged = data.firstName !== undefined || data.lastName !== undefined;
  if (nameChanged) {
    const currentRow = await pool.query<{
      first_name_encrypted: string | null;
      last_name_encrypted: string | null;
    }>(
      'SELECT first_name_encrypted, last_name_encrypted FROM workers WHERE id = $1',
      [workerId],
    );
    const [currentFirstName, currentLastName] = await Promise.all([
      encryptionService.decrypt(currentRow.rows[0]?.first_name_encrypted ?? ''),
      encryptionService.decrypt(currentRow.rows[0]?.last_name_encrypted ?? ''),
    ]);
    const finalFirstName = data.firstName ?? currentFirstName ?? null;
    const finalLastName  = data.lastName  ?? currentLastName  ?? null;
    const bidxBuffers = await blindIndexService.generateNameTrigramBidx(finalFirstName, finalLastName);
    const bidxLiteral = blindIndexService.serializeForPg(bidxBuffers);
    sets.push(`name_trgm_bidx = $${idx++}::bytea[]`);
    values.push(bidxLiteral);
  }

  if (sets.length === 0) return;
  await pool.query(
    `UPDATE workers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
    values,
  );
  await recalcFn(workerId);
}

export async function addDataSource(pool: Pool, workerId: string, source: string): Promise<void> {
  await pool.query(
    `UPDATE workers
     SET data_sources = ARRAY(
       SELECT DISTINCT unnest(array_append(COALESCE(data_sources, '{}'), $2::text))
     )
     WHERE id = $1`,
    [workerId, source],
  );
}

export async function recalculateStatus(
  pool: Pool,
  workerId: string,
  updateStatusFn: (workerId: string, status: WorkerStatus) => Promise<void>,
): Promise<WorkerStatus | null> {
  const { rows } = await pool.query<{ current_status: string; is_complete: boolean }>(
    `SELECT
       w.status AS current_status,
       (
         w.first_name_encrypted IS NOT NULL AND w.first_name_encrypted <> '' AND
         w.last_name_encrypted  IS NOT NULL AND w.last_name_encrypted  <> '' AND
         w.sex_encrypted        IS NOT NULL AND w.sex_encrypted        <> '' AND
         w.gender_encrypted     IS NOT NULL AND w.gender_encrypted     <> '' AND
         w.birth_date_encrypted IS NOT NULL AND w.birth_date_encrypted <> '' AND
         w.document_number_encrypted IS NOT NULL AND w.document_number_encrypted <> '' AND
         w.languages_encrypted  IS NOT NULL AND w.languages_encrypted  <> '' AND
         w.phone IS NOT NULL AND w.phone <> '' AND
         w.profession       IS NOT NULL AND w.profession       <> '' AND
         w.knowledge_level  IS NOT NULL AND w.knowledge_level  <> '' AND
         w.title_certificate IS NOT NULL AND w.title_certificate <> '' AND
         w.years_experience IS NOT NULL AND w.years_experience <> '' AND
         w.experience_types  IS NOT NULL AND array_length(w.experience_types, 1)  > 0 AND
         w.preferred_types   IS NOT NULL AND array_length(w.preferred_types, 1)   > 0 AND
         w.preferred_age_range IS NOT NULL AND array_length(w.preferred_age_range, 1) > 0 AND
         EXISTS (SELECT 1 FROM worker_service_areas sa WHERE sa.worker_id = w.id AND sa.address_line IS NOT NULL AND sa.radius_km IS NOT NULL) AND
         EXISTS (SELECT 1 FROM worker_availability  av WHERE av.worker_id = w.id) AND
         EXISTS (
           SELECT 1 FROM worker_documents wd
           WHERE wd.worker_id = w.id
             AND wd.resume_cv_url              IS NOT NULL
             AND wd.identity_document_url       IS NOT NULL
             AND wd.criminal_record_url         IS NOT NULL
             AND wd.professional_registration_url IS NOT NULL
             AND wd.liability_insurance_url     IS NOT NULL
         )
       ) AS is_complete
     FROM workers w
     WHERE w.id = $1`,
    [workerId],
  );

  if (rows.length === 0) return null;
  const { current_status, is_complete } = rows[0];

  if (current_status === 'DISABLED') return null;

  const newStatus: WorkerStatus = is_complete ? 'REGISTERED' : 'INCOMPLETE_REGISTER';
  if (newStatus === current_status) return null;

  await updateStatusFn(workerId, newStatus);
  return newStatus;
}
