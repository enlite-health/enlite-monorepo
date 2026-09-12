import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientResponsibleInput, PatientResponsiblePatch } from '../domain/PatientResponsible';
import { deactivateRow, type DeactivateOutcome } from './deactivateRowByRow';

/**
 * 409 — já existe titular ATIVO para este paciente (índice `idx_patient_responsibles_one_primary`,
 * migration 420: o índice passou a olhar só linhas `active`).
 */
export class ResponsiblePrimaryAlreadySetError extends Error {
  readonly code = 'PRIMARY_ALREADY_SET';
  constructor() { super('Já existe um responsável titular ativo para este paciente'); }
}

const PRIMARY_UNIQUE_VIOLATION = '23505';
const PRIMARY_INDEX_NAME = 'idx_patient_responsibles_one_primary';

export type { DeactivateOutcome };

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
   * `POST /patients/:id/responsibles` (spec 018, PR-1, ADR-1) — escrita por LINHA: id novo,
   * nunca mexe nos outros. `client` é obrigatório (a rota sempre roda sob `withActorContext` —
   * RLS de país da stage; `inPatientTransaction`).
   *
   * `display_order` NÃO vem do chamador (achado do gate `revisao-pr`): é `MAX(display_order)+1`
   * dentre as linhas do paciente, no MOLDE de `PatientAddressRepository.insertOne` (o repositório
   * irmão que já resolvia "nova linha entra no FIM"). Antes, o controller mandava `0` fixo — com
   * dois não-titulares (`display_order` empatado), a ordem da ficha virava indeterminada (heap).
   */
  async insertOne(
    patientId: string,
    input: Omit<PatientResponsibleInput, 'displayOrder'>,
    actorUid: string,
    client: PoolClient,
  ): Promise<{ id: string }> {
    const [phoneEnc, emailEnc, documentNumberEnc] = await Promise.all([
      this.encryptionService.encrypt(input.phone ?? null),
      this.encryptionService.encrypt(input.email ?? null),
      this.encryptionService.encrypt(input.documentNumber ?? null),
    ]);
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO patient_responsibles
          (patient_id, first_name, last_name, relationship,
           phone_encrypted, email_encrypted, document_number_encrypted,
           document_type, is_primary, display_order, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
           (SELECT COALESCE(MAX(display_order), 0) + 1 FROM patient_responsibles WHERE patient_id = $1),
           $10, $11)
         RETURNING id`,
        [
          patientId,
          input.firstName.trim(),
          input.lastName.trim(),
          input.relationship ?? null,
          phoneEnc,
          emailEnc,
          documentNumberEnc,
          input.documentType ?? null,
          input.isPrimary,
          input.source ?? 'admin_manual',
          actorUid,
        ],
      );
      return { id: rows[0].id };
    } catch (err: unknown) {
      throw this.mapPrimaryConflict(err);
    }
  }

  /**
   * `PATCH /patients/:id/responsibles/:rid` — UPDATE parcial de UMA linha (RFC 7396): chave
   * ausente do `patch` não toca a coluna; `null` explícito apaga o campo. `WHERE id = $1 AND
   * patient_id = $2`: id de outro paciente não é encontrado (404 no controller — lição
   * `lista-filtrada-mais-replace-all-apaga` não se aplica aqui porque não há mais lista).
   * Devolve `null` quando a linha não existe (id errado ou de outro paciente).
   */
  async updateOne(
    patientId: string,
    id: string,
    patch: PatientResponsiblePatch,
    client: PoolClient,
  ): Promise<{ id: string } | null> {
    const sets: string[] = [];
    const values: unknown[] = [patientId, id];

    const setColumn = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (Object.prototype.hasOwnProperty.call(patch, 'firstName') && patch.firstName !== undefined) {
      setColumn('first_name', patch.firstName.trim());
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastName') && patch.lastName !== undefined) {
      setColumn('last_name', patch.lastName.trim());
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'relationship')) {
      setColumn('relationship', patch.relationship ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'documentType')) {
      setColumn('document_type', patch.documentType ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'isPrimary') && patch.isPrimary !== undefined) {
      setColumn('is_primary', patch.isPrimary);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'phone')) {
      setColumn('phone_encrypted', await this.encryptionService.encrypt(patch.phone ?? null));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'email')) {
      setColumn('email_encrypted', await this.encryptionService.encrypt(patch.email ?? null));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'documentNumber')) {
      setColumn('document_number_encrypted', await this.encryptionService.encrypt(patch.documentNumber ?? null));
    }

    if (sets.length === 0) {
      // PATCH vazio é no-op — MAS não é sucesso cego (achado do gate `revisao-pr`: um PATCH {}
      // no id de OUTRO paciente, ou numa linha já desativada, respondia 200 sem checar nada).
      // Mesma régua do UPDATE abaixo: só existe/pertence/está ativa → { id }; senão, null (404).
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM patient_responsibles WHERE id = $2 AND patient_id = $1 AND active`,
        [patientId, id],
      );
      return rows[0] ? { id: rows[0].id } : null;
    }
    sets.push('updated_at = NOW()');

    try {
      // `AND active` (task 1.10, alt 2): editar uma linha que outra aba já desativou não é mais
      // "editar" — a linha está removida do painel. 0 linhas ⇒ null ⇒ o controller devolve 404,
      // indistinguível de "nunca existiu" (a mesma régua do id de outro paciente).
      const { rows } = await client.query<{ id: string }>(
        `UPDATE patient_responsibles SET ${sets.join(', ')}
          WHERE id = $2 AND patient_id = $1 AND active
          RETURNING id`,
        values,
      );
      return rows[0] ? { id: rows[0].id } : null;
    } catch (err: unknown) {
      throw this.mapPrimaryConflict(err);
    }
  }

  /**
   * `POST /patients/:id/responsibles/:rid/deactivate` — nunca DELETE (FR-002). `SELECT … FOR
   * UPDATE` antes do `UPDATE` para o controller distinguir 404 (linha não existe/é de outro
   * paciente) de 409 (já está inativa) — os dois são erros diferentes para quem chama duas vezes.
   */
  async deactivate(
    patientId: string,
    id: string,
    actorUid: string,
    client: PoolClient,
  ): Promise<DeactivateOutcome> {
    return deactivateRow(client, 'patient_responsibles', patientId, id, actorUid);
  }

  /** 23505 no índice de titular único → 409 legível; qualquer outro erro passa intocado. */
  private mapPrimaryConflict(err: unknown): unknown {
    const pgErr = err as { code?: string; constraint?: string } | null;
    if (pgErr?.code === PRIMARY_UNIQUE_VIOLATION && pgErr.constraint === PRIMARY_INDEX_NAME) {
      return new ResponsiblePrimaryAlreadySetError();
    }
    return err;
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
