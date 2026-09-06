import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientResponsibleInput } from '../domain/PatientResponsible';

/**
 * PatientResponsibleRepository — CRUD on patient_responsibles.
 * PII (phone, email, document_number) encrypted via KMS before storage.
 * Does NOT join workers, job_postings, or any domain outside patient.
 */
export class PatientResponsibleRepository {
  private pool: Pool;
  private encryptionService: KMSEncryptionService;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  /**
   * Replaces ALL responsibles for a patient (DELETE + INSERT) — the DRAWER path:
   * the screen edits the whole list, so the whole list is what it sends.
   * Enforces at most 1 is_primary=true via partial unique index in DB.
   */
  async replaceAll(
    patientId: string,
    responsibles: PatientResponsibleInput[],
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      'DELETE FROM patient_responsibles WHERE patient_id = $1',
      [patientId],
    );
    await this.insertRows(executor, patientId, responsibles, false);
  }

  /**
   * Replaces ONLY the rows of one `source` — the SYNC path (QA caça 🔴1, spec 011).
   *
   * O sync do ClickUp chamava `replaceAll` e o mapper devolve `[]` quando a task
   * não tem responsável: um familiar criado no painel ('admin_manual') ou pelo
   * formulário público ('web_form') sumia no `taskUpdated` seguinte. Aqui só as
   * linhas daquela procedência são substituídas; as demais ficam intactas.
   *
   * Como o banco exige no máximo 1 titular por paciente
   * (idx_patient_responsibles_one_primary), quando já existe titular de OUTRA
   * procedência as linhas novas entram como não-titular — a escolha feita no
   * painel vale mais que o espelho, e o sync não pode quebrar por isso.
   */
  async replaceBySource(
    patientId: string,
    responsibles: PatientResponsibleInput[],
    source: string,
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;
    const other = await executor.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM patient_responsibles
         WHERE patient_id = $1 AND is_primary = true AND source <> $2
       ) AS exists`,
      [patientId, source],
    );
    await executor.query(
      'DELETE FROM patient_responsibles WHERE patient_id = $1 AND source = $2',
      [patientId, source],
    );
    await this.insertRows(executor, patientId, responsibles, other.rows[0].exists);
  }

  /** Shared INSERT of replaceAll/replaceBySource: encrypts PII, trims names, skips nameless rows. */
  private async insertRows(
    executor: Pool | PoolClient,
    patientId: string,
    responsibles: PatientResponsibleInput[],
    demotePrimary: boolean,
  ): Promise<void> {
    const valid = responsibles.filter(r => r.firstName?.trim() || r.lastName?.trim());
    if (valid.length === 0) return;

    // Encrypt PII for each responsible in parallel
    const encrypted = await Promise.all(
      valid.map(async r => ({
        phoneEnc:          await this.encryptionService.encrypt(r.phone ?? null),
        emailEnc:          await this.encryptionService.encrypt(r.email ?? null),
        documentNumberEnc: await this.encryptionService.encrypt(r.documentNumber ?? null),
      })),
    );

    const values: unknown[] = [];
    const placeholders = valid.map((r, i) => {
      const base = i * 11;
      values.push(
        patientId,
        r.firstName.trim(),
        r.lastName.trim(),
        r.relationship    ?? null,
        encrypted[i].phoneEnc,
        encrypted[i].emailEnc,
        encrypted[i].documentNumberEnc,
        r.documentType    ?? null,
        demotePrimary ? false : r.isPrimary,
        r.displayOrder,
        r.source          ?? 'clickup',
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
    });

    await executor.query(
      `INSERT INTO patient_responsibles
        (patient_id, first_name, last_name, relationship,
         phone_encrypted, email_encrypted, document_number_encrypted,
         document_type, is_primary, display_order, source)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  /**
   * Idempotent single-primary insert used by the backfill script.
   * Skips insert if a primary responsible already exists for the patient.
   */
  async insertIfNoPrimary(
    patientId: string,
    responsible: PatientResponsibleInput,
    client?: PoolClient,
  ): Promise<{ action: 'inserted' | 'skipped' }> {
    const executor = client ?? this.pool;

    const exists = await executor.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM patient_responsibles
         WHERE patient_id = $1 AND is_primary = true
       ) AS exists`,
      [patientId],
    );

    if (exists.rows[0].exists) {
      return { action: 'skipped' };
    }

    const phoneEnc          = await this.encryptionService.encrypt(responsible.phone ?? null);
    const documentNumberEnc = await this.encryptionService.encrypt(responsible.documentNumber ?? null);
    // email_encrypted: legacy patients table had no responsible_email column → stays null
    const emailEnc: string | null = null;

    await executor.query(
      `INSERT INTO patient_responsibles
        (patient_id, first_name, last_name, relationship,
         phone_encrypted, email_encrypted, document_number_encrypted,
         document_type, is_primary, display_order, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        patientId,
        responsible.firstName.trim(),
        responsible.lastName.trim(),
        responsible.relationship    ?? null,
        phoneEnc,
        emailEnc,
        documentNumberEnc,
        responsible.documentType    ?? null,
        true,
        1,
        responsible.source ?? 'legacy-patients-column',
      ],
    );

    return { action: 'inserted' };
  }

  async findByPatientId(patientId: string): Promise<Array<{
    id: string;
    firstName: string;
    lastName: string;
    relationship: string | null;
    phoneEncrypted: string | null;
    emailEncrypted: string | null;
    documentNumberEncrypted: string | null;
    documentType: string | null;
    isPrimary: boolean;
    displayOrder: number;
    source: string;
  }>> {
    const result = await this.pool.query(
      `SELECT
        id,
        first_name AS "firstName",
        last_name AS "lastName",
        relationship,
        phone_encrypted AS "phoneEncrypted",
        email_encrypted AS "emailEncrypted",
        document_number_encrypted AS "documentNumberEncrypted",
        document_type AS "documentType",
        is_primary AS "isPrimary",
        display_order AS "displayOrder",
        source
       FROM patient_responsibles
       WHERE patient_id = $1
       ORDER BY display_order ASC, is_primary DESC`,
      [patientId],
    );
    return result.rows;
  }
}
