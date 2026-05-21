import { Pool } from 'pg';
import { IWorkerRepository } from '../ports/IWorkerRepository';
import { Worker, WorkerStatus, CreateWorkerDTO, SavePersonalInfoDTO } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizePhoneAR } from '@shared/utils/phoneNormalization';
import type { PubSubClient } from '@shared/events/PubSubClient';
import { countryToTimezone } from '@shared/locale/CountryTimezone';
import { updatePersonalInfo as _updatePersonalInfo } from './WorkerPersonalInfoRepository';
import {
  findByCuit as _findByCuit,
  updateFromImport as _updateFromImport,
  addDataSource as _addDataSource,
  WorkerImportData,
} from './WorkerImportRepository';
import {
  findByAuthUid as _findByAuthUid,
  updateAuthUid as _updateAuthUid,
  updateImportedWorkerData as _updateImportedWorkerData,
} from './WorkerAuthRepository';
import {
  updateWorkerStatus as _updateWorkerStatus,
  recalculateWorkerStatus as _recalculateWorkerStatus,
} from './WorkerStatusRepository';

// ── WorkerWithPii — dados decriptados retornados por findByIdWithPii ──────────
export interface WorkerWithPii {
  id: string;
  email: string;
  phone: string | null;
  status: string;
  profession: string | null;
  occupation: string | null;
  employment_type: string | null;
  /** Decriptados via KMS */
  firstName: string | null;
  lastName: string | null;
  sex: string | null;
  birthDate: string | null;
  documentNumber: string | null;
  anaCareSyncedAt: Date | null;
  anaCareId: string | null;
}

export class WorkerRepository implements IWorkerRepository {
  private pool: Pool;
  private encryptionService: KMSEncryptionService;
  private blindIndexService: BlindIndexService;
  private readonly pubsub: PubSubClient | null;

  constructor(pubsub?: PubSubClient) {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.blindIndexService = new BlindIndexService();
    this.pubsub = pubsub ?? null;
  }

  async create(data: CreateWorkerDTO): Promise<Result<Worker>> {
    try {
      const consentAt = data.lgpdOptIn ? new Date() : null;
      const whatsappPhoneEnc = await this.encryptionService.encrypt(data.whatsappPhone || null);
      // Normaliza o phone na borda do create para garantir unicidade semântica.
      // normalizePhoneAR retorna '' para entrada vazia — converte para null.
      const rawPhone = data.phone || null;
      const normalizedPhone = rawPhone ? (normalizePhoneAR(rawPhone) || rawPhone) : null;
      const query = `
        INSERT INTO workers (auth_uid, email, phone, whatsapp_phone_encrypted, lgpd_consent_at, terms_accepted_at, privacy_accepted_at, country, timezone, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'INCOMPLETE_REGISTER')
        RETURNING id, auth_uid as "authUid", email, phone,
                  lgpd_consent_at as "lgpdConsentAt",
                  terms_accepted_at as "termsAcceptedAt",
                  privacy_accepted_at as "privacyAcceptedAt",
                  country, timezone,
                  created_at as "createdAt",
                  updated_at as "updatedAt"
      `;

      const country = data.country || 'AR';
      // TD-028: derivar timezone do country quando ausente (default 'UTC' antigo
      // resultava em 100% dos workers com timezone errado pra AR/BR).
      const timezone = data.timezone || countryToTimezone(country);
      const values = [
        data.authUid,
        data.email,
        normalizedPhone,
        whatsappPhoneEnc,
        consentAt,
        consentAt,
        consentAt,
        country,
        timezone,
      ];
      const result = await this.pool.query(query, values);
      const row = result.rows[0];
      row.whatsappPhone = data.whatsappPhone || undefined;

      return Result.ok<Worker>(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Result.fail<Worker>(`Failed to create worker: ${msg}`);
    }
  }

  async findById(id: string): Promise<Result<Worker | null>> {
    try {
      const query = `
        SELECT id, auth_uid as "authUid", email, phone,
               whatsapp_phone_encrypted as "whatsappPhoneEnc",
               lgpd_consent_at as "lgpdConsentAt",
               country, timezone,
               created_at as "createdAt", updated_at as "updatedAt"
        FROM workers
        WHERE id = $1
      `;

      const result = await this.pool.query(query, [id]);

      if (result.rows.length === 0) {
        return Result.ok<Worker | null>(null);
      }

      const row = result.rows[0];
      row.whatsappPhone = (await this.encryptionService.decrypt(row.whatsappPhoneEnc)) || undefined;
      delete row.whatsappPhoneEnc;

      return Result.ok<Worker>(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Result.fail<Worker | null>(`Failed to find worker: ${msg}`);
    }
  }

  async findByAuthUid(authUid: string): Promise<Result<Worker | null>> {
    return _findByAuthUid(this.pool, this.encryptionService, authUid);
  }

  async findByEmail(email: string): Promise<Result<Worker | null>> {
    try {
      const query = `
        SELECT id, auth_uid as "authUid", email, phone,
               whatsapp_phone_encrypted as "whatsappPhoneEnc",
               lgpd_consent_at as "lgpdConsentAt",
               country, timezone,
               created_at as "createdAt", updated_at as "updatedAt"
        FROM workers WHERE email = $1
      `;

      const result = await this.pool.query(query, [email]);

      if (result.rows.length === 0) {
        return Result.ok<Worker | null>(null);
      }

      const row = result.rows[0];
      row.whatsappPhone = (await this.encryptionService.decrypt(row.whatsappPhoneEnc)) || undefined;
      delete row.whatsappPhoneEnc;

      return Result.ok<Worker>(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Result.fail<Worker | null>(`Failed to find worker: ${msg}`);
    }
  }

  async updatePersonalInfo(
    data: Omit<SavePersonalInfoDTO, 'termsAccepted' | 'privacyAccepted'> & {
      termsAccepted: boolean;
      privacyAccepted: boolean;
    },
  ): Promise<Result<Worker>> {
    return _updatePersonalInfo(this.pool, this.encryptionService, this.blindIndexService, data);
  }

  async delete(workerId: string): Promise<Result<void>> {
    try {
      await this.pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
      return Result.ok<void>();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Result.fail<void>(`Failed to delete worker: ${msg}`);
    }
  }

  async deleteByAuthUid(authUid: string): Promise<Result<void>> {
    try {
      await this.pool.query('DELETE FROM workers WHERE auth_uid = $1', [authUid]);
      return Result.ok<void>();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Result.fail<void>(`Failed to delete worker: ${msg}`);
    }
  }

  /**
   * Busca worker por ID com campos PII DECRIPTADOS via KMS.
   * NÃO usar em request handlers síncronos sem contexto de auditoria.
   * PII-SAFETY: os valores decriptados NUNCA podem ir para logs.
   */
  async findByIdWithPii(id: string): Promise<WorkerWithPii | null> {
    const result = await this.pool.query(
      `SELECT
         id, email, phone, status, profession, occupation, employment_type,
         first_name_encrypted  AS "firstNameEnc",
         last_name_encrypted   AS "lastNameEnc",
         sex_encrypted         AS "sexEnc",
         birth_date_encrypted  AS "birthDateEnc",
         document_number_encrypted AS "documentNumberEnc",
         ana_care_synced_at    AS "anaCareSyncedAt",
         ana_care_id           AS "anaCareId"
       FROM workers
       WHERE id = $1 AND merged_into_id IS NULL`,
      [id],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0] as {
      id: string; email: string; phone: string | null; status: string;
      profession: string | null; occupation: string | null; employment_type: string | null;
      firstNameEnc: string | null; lastNameEnc: string | null; sexEnc: string | null;
      birthDateEnc: string | null; documentNumberEnc: string | null;
      anaCareSyncedAt: Date | null; anaCareId: string | null;
    };

    const [firstName, lastName, sex, birthDate, documentNumber] = await Promise.all([
      row.firstNameEnc ? this.encryptionService.decrypt(row.firstNameEnc) : Promise.resolve(null),
      row.lastNameEnc ? this.encryptionService.decrypt(row.lastNameEnc) : Promise.resolve(null),
      row.sexEnc ? this.encryptionService.decrypt(row.sexEnc) : Promise.resolve(null),
      row.birthDateEnc ? this.encryptionService.decrypt(row.birthDateEnc) : Promise.resolve(null),
      row.documentNumberEnc ? this.encryptionService.decrypt(row.documentNumberEnc) : Promise.resolve(null),
    ]);

    return {
      id: row.id, email: row.email, phone: row.phone, status: row.status,
      profession: row.profession, occupation: row.occupation,
      employment_type: row.employment_type,
      firstName: firstName || null, lastName: lastName || null,
      sex: sex || null, birthDate: birthDate || null,
      documentNumber: documentNumber || null,
      anaCareSyncedAt: row.anaCareSyncedAt, anaCareId: row.anaCareId,
    };
  }

  async updateAuthUid(workerId: string, authUid: string, phone?: string, consentAt?: Date): Promise<Result<Worker>> {
    return _updateAuthUid(this.pool, this.encryptionService, workerId, authUid, phone, consentAt);
  }

  async findByPhone(phone: string): Promise<Result<Worker | null>> {
    try {
      const result = await this.pool.query(
        `SELECT id, auth_uid as "authUid", email, phone, country,
                created_at as "createdAt", updated_at as "updatedAt"
         FROM workers WHERE phone = $1`,
        [phone],
      );
      if (result.rows.length === 0) return Result.ok<Worker | null>(null);
      return Result.ok<Worker>(result.rows[0]);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Result.fail<Worker | null>(`Failed to find worker by phone: ${msg}`);
    }
  }

  async findByPhoneCandidates(candidates: string[]): Promise<Result<Worker | null>> {
    try {
      if (candidates.length === 0) return Result.ok<Worker | null>(null);
      // Só considera workers ATIVOS: não-merged (espelha idx_workers_phone_normalized,
      // mig 219) e não soft-deletados — conta com deleted_at não pode bloquear o
      // número de quem está se cadastrando (caso Edith, diagnóstico 03/08).
      const result = await this.pool.query(
        `SELECT id, auth_uid as "authUid", email, phone, country,
                created_at as "createdAt", updated_at as "updatedAt"
         FROM workers
         WHERE phone = ANY($1::text[])
           AND merged_into_id IS NULL
           AND deleted_at IS NULL
         LIMIT 1`,
        [candidates],
      );
      if (result.rows.length === 0) return Result.ok<Worker | null>(null);
      return Result.ok<Worker>(result.rows[0]);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Result.fail<Worker | null>(`Failed to find worker by phone: ${msg}`);
    }
  }

  /** Busca worker pelo CUIT/CUIL (identificador fiscal argentino, 11 dígitos). */
  async findByCuit(cuit: string): Promise<Result<Worker | null>> {
    return _findByCuit(this.pool, cuit);
  }

  async updateFromImport(workerId: string, data: WorkerImportData): Promise<void> {
    return _updateFromImport(
      this.pool, this.encryptionService, this.blindIndexService, workerId, data,
      (id) => this.recalculateStatus(id),
    );
  }

  /** Registra qual import contribuiu dados para este worker (sem duplicar na array). */
  async addDataSource(workerId: string, source: string): Promise<void> {
    return _addDataSource(this.pool, workerId, source);
  }

  /**
   * Updates worker status inside a transaction so the trigger
   * trg_worker_status_history fires and records the transition.
   * Delegates to WorkerStatusRepository.
   */
  async updateStatus(workerId: string, status: WorkerStatus): Promise<void> {
    return _updateWorkerStatus(this.pool, workerId, status);
  }

  /**
   * Recalculates worker status. When the new status is REGISTERED the status
   * UPDATE and domain_events INSERT are atomic (same transaction). After
   * commit, publishes to Pub/Sub best-effort. Delegates to WorkerStatusRepository.
   */
  async recalculateStatus(workerId: string): Promise<WorkerStatus | null> {
    return _recalculateWorkerStatus(this.pool, workerId, this.pubsub);
  }

  async updateImportedWorkerData(
    workerId: string,
    data: { authUid: string; email: string; consentAt?: Date },
  ): Promise<Result<Worker>> {
    return _updateImportedWorkerData(this.pool, this.encryptionService, workerId, data);
  }

  /**
   * Marks/unmarks a worker as a test account. Returns the resulting flag,
   * or null if no worker with that id exists (excluding merged-away rows).
   */
  async updateTestFlag(workerId: string, isTest: boolean): Promise<boolean | null> {
    const result = await this.pool.query<{ is_test: boolean }>(
      'UPDATE workers SET is_test = $2, updated_at = NOW() WHERE id = $1 AND merged_into_id IS NULL RETURNING is_test',
      [workerId, isTest],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].is_test;
  }
}
