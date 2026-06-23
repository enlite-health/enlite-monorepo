/**
 * UpdateWorkerProfileFieldsUseCase
 *
 * PATCH-like use case: updates only the provided fields on a worker profile.
 * Limited to the LGPD-compliant whitelist defined in sprint §5.2.
 *
 * Distinct from SavePersonalInfoUseCase, which requires ALL fields (used by
 * the registration wizard flow). This use case is designed for partial updates
 * from the MCP triage channel.
 *
 * Fields that map to encrypted columns are encrypted via KMS before writing.
 * Address fields are updated in worker_service_areas (upsert the primary row).
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { logger, reportError } from '@shared/logging';
import type { EntityFieldDiff } from '@shared/audit/types';
import { captureWorkerBefore } from './workerAuditDiff';

export interface WorkerProfilePatch {
  workerId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  /** CPF (BR) or DNI equivalent — stored as document_number_encrypted */
  cpf?: string;
  /** RG (BR) — stored as document_number_encrypted when documentType=RG */
  rg?: string;
  /** Generic document number (DNI/CEDULA/LE_LC/PASSPORT, Latam) — stored as document_number_encrypted */
  documentNumber?: string;
  /** Canonical document type (DNI, PASSPORT, CEDULA, LE_LC, CPF) — plaintext document_type column */
  documentType?: string;
  /** ISO date YYYY-MM-DD */
  birthDate?: string;
  /** Canonical profession enum (AT, CUIDADOR, …) — plaintext `profession` column. */
  profession?: string;
  meiNumber?: string;
  meiCnpj?: string;
  // ── Professional data ──
  /** Plaintext `occupation` column (AT/CUIDADOR/AMBOS). */
  occupation?: string;
  /** Plaintext `knowledge_level` column. */
  knowledgeLevel?: string;
  /** Plaintext `title_certificate` column (free text). */
  titleCertificate?: string;
  /** Plaintext `years_experience` column. */
  yearsExperience?: string;
  /** Plaintext TEXT[] `experience_types` column. */
  experienceTypes?: string[];
  /** Plaintext TEXT[] `preferred_types` column. */
  preferredTypes?: string[];
  /** Plaintext TEXT[] `preferred_age_range` column. */
  preferredAgeRange?: string[];
  /** Encrypted `languages_encrypted` (JSON) + `languages_bidx` blind index. */
  languages?: string[];
  /** Encrypted `linkedin_url_encrypted` column. */
  linkedinUrl?: string;
  address?: {
    street?: string;
    number?: string;
    complement?: string;
    neighborhood?: string;
    city?: string;
    zipCode?: string;
    state?: string;
  };
}

export interface UpdateWorkerProfileFieldsResult {
  workerId: string;
  fieldsUpdated: string[];
  /** Diff antes→depois por campo, para auditoria. */
  changes: EntityFieldDiff[];
}

export class WorkerNotFoundError extends Error {
  readonly code = 'WORKER_NOT_FOUND';
  constructor(workerId: string) {
    super(`Worker not found: ${workerId}`);
    this.name = 'WorkerNotFoundError';
  }
}

export class UpdateWorkerProfileFieldsUseCase {
  private readonly pool: Pool;
  private readonly encryptionService: KMSEncryptionService;
  private readonly blindIndexService: BlindIndexService;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.blindIndexService = new BlindIndexService();
  }

  async execute(patch: WorkerProfilePatch): Promise<UpdateWorkerProfileFieldsResult> {
    const { workerId, address, ...scalarFields } = patch;
    const log = logger.child({ workerId, useCase: 'UpdateWorkerProfileFieldsUseCase' });

    // 1. Verify worker exists
    const workerCheck = await this.pool.query(
      'SELECT id FROM workers WHERE id = $1',
      [workerId],
    );
    if (workerCheck.rows.length === 0) {
      throw new WorkerNotFoundError(workerId);
    }

    // Snapshot "before" (decriptado) para o diff de auditoria.
    const before = await captureWorkerBefore(this.pool, this.encryptionService, workerId);

    const fieldsUpdated: string[] = [];

    // 2. Update scalar fields on workers table
    await this.updateScalarFields(workerId, scalarFields, fieldsUpdated);

    // 3. Update address in worker_service_areas if provided
    if (address && Object.values(address).some((v) => v !== undefined)) {
      await this.updateAddress(workerId, address);
      fieldsUpdated.push('address');
    }

    const afterMap = scalarFields as Record<string, unknown>;
    const changes: EntityFieldDiff[] = fieldsUpdated.map((field) => ({
      field,
      before: before[field] ?? null,
      after: field === 'address' ? address ?? null : afterMap[field] ?? null,
    }));

    log.info({ msg: 'profile fields updated', fieldsUpdated });
    return { workerId, fieldsUpdated, changes };
  }

  private async updateScalarFields(
    workerId: string,
    fields: Omit<WorkerProfilePatch, 'workerId' | 'address'>,
    fieldsUpdated: string[],
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [workerId];
    let idx = 2;

    // email — plaintext column
    if (fields.email !== undefined) {
      sets.push(`email = $${idx++}`);
      values.push(fields.email);
      fieldsUpdated.push('email');
    }

    // document_type — plaintext indicator column (DNI/CPF/CEDULA/LE_LC/PASSPORT)
    if (fields.documentType !== undefined) {
      sets.push(`document_type = $${idx++}`);
      values.push(fields.documentType);
      fieldsUpdated.push('documentType');
    }

    // profession — plaintext enum column (AT/CUIDADOR/…). Note: writing this can
    // flip the worker to REGISTERED via the fn_guard_registered_status trigger (mig 208).
    if (fields.profession !== undefined) {
      sets.push(`profession = $${idx++}`);
      values.push(fields.profession);
      fieldsUpdated.push('profession');
    }

    // meiNumber, meiCnpj — plaintext columns (operational, not PII-encrypted)
    if (fields.meiNumber !== undefined) {
      sets.push(`mei_number = $${idx++}`);
      values.push(fields.meiNumber);
      fieldsUpdated.push('meiNumber');
    }
    if (fields.meiCnpj !== undefined) {
      sets.push(`mei_cnpj = $${idx++}`);
      values.push(fields.meiCnpj);
      fieldsUpdated.push('meiCnpj');
    }

    // Professional data — plaintext scalar columns
    const plainScalars: Array<['occupation' | 'knowledgeLevel' | 'titleCertificate' | 'yearsExperience', string]> = [
      ['occupation', 'occupation'],
      ['knowledgeLevel', 'knowledge_level'],
      ['titleCertificate', 'title_certificate'],
      ['yearsExperience', 'years_experience'],
    ];
    for (const [key, column] of plainScalars) {
      const v = fields[key];
      if (v !== undefined) {
        sets.push(`${column} = $${idx++}`);
        values.push(v);
        fieldsUpdated.push(key);
      }
    }

    // Professional data — plaintext TEXT[] array columns
    const plainArrays: Array<['experienceTypes' | 'preferredTypes' | 'preferredAgeRange', string]> = [
      ['experienceTypes', 'experience_types'],
      ['preferredTypes', 'preferred_types'],
      ['preferredAgeRange', 'preferred_age_range'],
    ];
    for (const [key, column] of plainArrays) {
      const v = fields[key];
      if (v !== undefined) {
        sets.push(`${column} = $${idx++}`);
        values.push(v);
        fieldsUpdated.push(key);
      }
    }

    // languages — encrypted JSON + blind index (mirror WorkerPersonalInfoRepository)
    if (fields.languages !== undefined) {
      const langs = fields.languages;
      const encryptedLangs = langs.length > 0
        ? (await this.encryptionService.encryptBatch({ languages: JSON.stringify(langs) })).languages
        : null;
      sets.push(`languages_encrypted = $${idx++}`);
      values.push(encryptedLangs);
      const langBidx = await this.blindIndexService.generateValuesBidx(langs);
      sets.push(`languages_bidx = $${idx++}::bytea[]`);
      values.push(this.blindIndexService.serializeForPg(langBidx));
      fieldsUpdated.push('languages');
    }

    // Encrypted PII fields — encrypt in batch
    const toEncrypt: Record<string, string> = {};
    if (fields.firstName !== undefined) toEncrypt.firstName = fields.firstName;
    if (fields.lastName  !== undefined) toEncrypt.lastName  = fields.lastName;
    if (fields.birthDate !== undefined) toEncrypt.birthDate = fields.birthDate;
    // document number maps to document_number_encrypted.
    // Precedence: generic documentNumber (Latam) > cpf > rg (all the same column).
    if (fields.documentNumber !== undefined) toEncrypt.documentNumber = fields.documentNumber;
    else if (fields.cpf !== undefined) toEncrypt.documentNumber = fields.cpf;
    else if (fields.rg !== undefined) toEncrypt.documentNumber = fields.rg;
    if (fields.linkedinUrl !== undefined) toEncrypt.linkedinUrl = fields.linkedinUrl;

    if (Object.keys(toEncrypt).length > 0) {
      let encrypted: Record<string, string | null>;
      try {
        encrypted = await this.encryptionService.encryptBatch(toEncrypt);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        reportError(e, { source: 'UpdateWorkerProfileFieldsUseCase:encryptBatch', workerId });
        throw e;
      }

      if (encrypted.firstName != null) {
        sets.push(`first_name_encrypted = $${idx++}`);
        values.push(encrypted.firstName);
        fieldsUpdated.push('firstName');
      }
      if (encrypted.lastName != null) {
        sets.push(`last_name_encrypted = $${idx++}`);
        values.push(encrypted.lastName);
        fieldsUpdated.push('lastName');
      }
      if (encrypted.birthDate != null) {
        sets.push(`birth_date_encrypted = $${idx++}`);
        values.push(encrypted.birthDate);
        fieldsUpdated.push('birthDate');
      }
      if (encrypted.documentNumber != null) {
        sets.push(`document_number_encrypted = $${idx++}`);
        values.push(encrypted.documentNumber);
        if (fields.documentNumber !== undefined) fieldsUpdated.push('documentNumber');
        else if (fields.cpf !== undefined) fieldsUpdated.push('cpf');
        else if (fields.rg !== undefined) fieldsUpdated.push('rg');
      }
      if (encrypted.linkedinUrl != null) {
        sets.push(`linkedin_url_encrypted = $${idx++}`);
        values.push(encrypted.linkedinUrl);
        fieldsUpdated.push('linkedinUrl');
      }
    }

    // Blind index for name search — regenerate if firstName or lastName changed
    const nameChanged = fields.firstName !== undefined || fields.lastName !== undefined;
    if (nameChanged) {
      const currentRow = await this.pool.query<{
        first_name_encrypted: string | null;
        last_name_encrypted: string | null;
      }>(
        'SELECT first_name_encrypted, last_name_encrypted FROM workers WHERE id = $1',
        [workerId],
      );
      const [currentFirst, currentLast] = await Promise.all([
        this.encryptionService.decrypt(currentRow.rows[0]?.first_name_encrypted ?? ''),
        this.encryptionService.decrypt(currentRow.rows[0]?.last_name_encrypted ?? ''),
      ]);
      const finalFirst = fields.firstName ?? currentFirst ?? null;
      const finalLast  = fields.lastName  ?? currentLast  ?? null;
      const bidxBuffers = await this.blindIndexService.generateNameTrigramBidx(finalFirst, finalLast);
      const bidxLiteral = this.blindIndexService.serializeForPg(bidxBuffers);
      sets.push(`name_trgm_bidx = $${idx++}::bytea[]`);
      values.push(bidxLiteral);
    }

    if (sets.length === 0) return;

    await this.pool.query(
      `UPDATE workers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
      values,
    );
  }

  private async updateAddress(
    workerId: string,
    address: NonNullable<WorkerProfilePatch['address']>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    // address.street → address_line
    if (address.street !== undefined) {
      sets.push(`address_line = $${idx++}`);
      values.push(address.street);
    }
    // address.number: the schema stores address_line as free-text without a dedicated number col;
    // number is accepted by the whitelist schema but merged conceptually with street.
    // Skip as separate column — callers should include it in `street` if needed.
    if (address.complement !== undefined) {
      sets.push(`address_complement = $${idx++}`);
      values.push(address.complement);
    }
    if (address.neighborhood !== undefined) {
      sets.push(`neighborhood = $${idx++}`);
      values.push(address.neighborhood);
    }
    if (address.city !== undefined) {
      sets.push(`city = $${idx++}`);
      values.push(address.city);
    }
    if (address.zipCode !== undefined) {
      sets.push(`postal_code = $${idx++}`);
      values.push(address.zipCode);
    }
    if (address.state !== undefined) {
      sets.push(`state = $${idx++}`);
      values.push(address.state);
    }

    if (sets.length === 0) return;

    // Update the oldest service area row for this worker (primary residence).
    // If none exists, skip — cannot create without required lat/lng/radius fields.
    const existing = await this.pool.query<{ id: string }>(
      'SELECT id FROM worker_service_areas WHERE worker_id = $1 ORDER BY created_at ASC LIMIT 1',
      [workerId],
    );

    if (existing.rows.length === 0) {
      logger.child({ workerId }).info({ msg: 'no service area row found — address update skipped' });
      return;
    }

    const saId = existing.rows[0].id;
    await this.pool.query(
      `UPDATE worker_service_areas SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      [...values, saId],
    );
  }
}
