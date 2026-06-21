import { Pool } from 'pg';
import { IWorkerRepository } from '../ports/IWorkerRepository';
import { Worker, WorkerStatus, CreateWorkerDTO, SavePersonalInfoDTO } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { updatePersonalInfo as _updatePersonalInfo } from './WorkerPersonalInfoRepository';
import {
  findByCuit as _findByCuit,
  updateFromImport as _updateFromImport,
  addDataSource as _addDataSource,
  recalculateStatus as _recalculateStatus,
  WorkerImportData,
} from './WorkerImportRepository';
import {
  findByAuthUid as _findByAuthUid,
  updateAuthUid as _updateAuthUid,
  updateImportedWorkerData as _updateImportedWorkerData,
} from './WorkerAuthRepository';

export class WorkerRepository implements IWorkerRepository {
  private pool: Pool;
  private encryptionService: KMSEncryptionService;
  private blindIndexService: BlindIndexService;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.blindIndexService = new BlindIndexService();
  }

  async create(data: CreateWorkerDTO): Promise<Result<Worker>> {
    try {
      const consentAt = data.lgpdOptIn ? new Date() : null;
      const whatsappPhoneEnc = await this.encryptionService.encrypt(data.whatsappPhone || null);
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

      const values = [
        data.authUid,
        data.email,
        data.phone || null,
        whatsappPhoneEnc,
        consentAt,
        consentAt,
        consentAt,
        data.country || 'AR',
        data.timezone || 'UTC',
      ];
      const result = await this.pool.query(query, values);
      const row = result.rows[0];
      row.whatsappPhone = data.whatsappPhone || undefined;

      return Result.ok<Worker>(row);
    } catch (error: any) {
      return Result.fail<Worker>(`Failed to create worker: ${error.message}`);
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
    } catch (error: any) {
      return Result.fail<Worker | null>(`Failed to find worker: ${error.message}`);
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
    } catch (error: any) {
      return Result.fail<Worker | null>(`Failed to find worker: ${error.message}`);
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
      const query = 'DELETE FROM workers WHERE id = $1';
      await this.pool.query(query, [workerId]);
      return Result.ok<void>();
    } catch (error: any) {
      return Result.fail<void>(`Failed to delete worker: ${error.message}`);
    }
  }

  async deleteByAuthUid(authUid: string): Promise<Result<void>> {
    try {
      const query = 'DELETE FROM workers WHERE auth_uid = $1';
      await this.pool.query(query, [authUid]);
      return Result.ok<void>();
    } catch (error: any) {
      return Result.fail<void>(`Failed to delete worker: ${error.message}`);
    }
  }

  async updateAuthUid(workerId: string, authUid: string, phone?: string, consentAt?: Date): Promise<Result<Worker>> {
    return _updateAuthUid(this.pool, this.encryptionService, workerId, authUid, phone, consentAt);
  }

  async findByPhone(phone: string): Promise<Result<Worker | null>> {
    try {
      const query = `
        SELECT id, auth_uid as "authUid", email, phone, country,
               created_at as "createdAt", updated_at as "updatedAt"
        FROM workers WHERE phone = $1
      `;
      const result = await this.pool.query(query, [phone]);
      if (result.rows.length === 0) return Result.ok<Worker | null>(null);
      return Result.ok<Worker>(result.rows[0]);
    } catch (error: any) {
      return Result.fail<Worker | null>(`Failed to find worker by phone: ${error.message}`);
    }
  }

  async findByPhoneCandidates(candidates: string[]): Promise<Result<Worker | null>> {
    try {
      if (candidates.length === 0) return Result.ok<Worker | null>(null);
      const query = `
        SELECT id, auth_uid as "authUid", email, phone, country,
               created_at as "createdAt", updated_at as "updatedAt"
        FROM workers WHERE phone = ANY($1::text[])
        LIMIT 1
      `;
      const result = await this.pool.query(query, [candidates]);
      if (result.rows.length === 0) return Result.ok<Worker | null>(null);
      return Result.ok<Worker>(result.rows[0]);
    } catch (error: any) {
      return Result.fail<Worker | null>(`Failed to find worker by phone: ${error.message}`);
    }
  }

  /** Busca worker pelo CUIT/CUIL (identificador fiscal argentino, 11 dígitos). */
  async findByCuit(cuit: string): Promise<Result<Worker | null>> {
    return _findByCuit(this.pool, cuit);
  }

  async updateFromImport(workerId: string, data: WorkerImportData): Promise<void> {
    return _updateFromImport(this.pool, this.encryptionService, this.blindIndexService, workerId, data, (id) =>
      this.recalculateStatus(id),
    );
  }

  /** Registra qual import contribuiu dados para este worker (sem duplicar na array). */
  async addDataSource(workerId: string, source: string): Promise<void> {
    return _addDataSource(this.pool, workerId, source);
  }

  /**
   * Updates worker status inside a transaction so the trigger
   * trg_worker_status_history fires and records the transition.
   */
  async updateStatus(workerId: string, status: WorkerStatus): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE workers SET status = $2, updated_at = NOW() WHERE id = $1',
        [workerId, status],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Delega para WorkerImportRepository para manter o arquivo sob 400 linhas. */
  async recalculateStatus(workerId: string): Promise<WorkerStatus | null> {
    return _recalculateStatus(this.pool, workerId, (id, s) => this.updateStatus(id, s));
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
