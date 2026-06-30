import { Pool } from 'pg';
import { IWorkerRepository } from '../ports/IWorkerRepository';
import { Worker, WorkerStatus, CreateWorkerDTO, SavePersonalInfoDTO } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { logger, loggingAls } from '@shared/logging';
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

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.blindIndexService = new BlindIndexService();
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

      const values = [
        data.authUid,
        data.email,
        normalizedPhone,
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

  /**
   * Busca worker por ID com campos PII DECRIPTADOS via KMS.
   *
   * Intencionado para sincronização externa (BackfillWorkerMirrorUseCase) que precisa
   * de nome/sexo/birthDate/documentNumber em plaintext para envio à plataforma AnaCare.
   *
   * VETO C2 do Architect: não adicionar flag ao findById existente — método separado.
   * NÃO usar em request handlers síncronos sem guardar contexto de auditoria.
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
      id: string;
      email: string;
      phone: string | null;
      status: string;
      profession: string | null;
      occupation: string | null;
      employment_type: string | null;
      firstNameEnc: string | null;
      lastNameEnc: string | null;
      sexEnc: string | null;
      birthDateEnc: string | null;
      documentNumberEnc: string | null;
      anaCareSyncedAt: Date | null;
      anaCareId: string | null;
    };

    const [firstName, lastName, sex, birthDate, documentNumber] = await Promise.all([
      row.firstNameEnc ? this.encryptionService.decrypt(row.firstNameEnc) : Promise.resolve(null),
      row.lastNameEnc ? this.encryptionService.decrypt(row.lastNameEnc) : Promise.resolve(null),
      row.sexEnc ? this.encryptionService.decrypt(row.sexEnc) : Promise.resolve(null),
      row.birthDateEnc ? this.encryptionService.decrypt(row.birthDateEnc) : Promise.resolve(null),
      row.documentNumberEnc ? this.encryptionService.decrypt(row.documentNumberEnc) : Promise.resolve(null),
    ]);

    return {
      id: row.id,
      email: row.email,
      phone: row.phone,
      status: row.status,
      profession: row.profession,
      occupation: row.occupation,
      employment_type: row.employment_type,
      firstName: firstName || null,
      lastName: lastName || null,
      sex: sex || null,
      birthDate: birthDate || null,
      documentNumber: documentNumber || null,
      anaCareSyncedAt: row.anaCareSyncedAt,
      anaCareId: row.anaCareId,
    };
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
      // Só considera workers ATIVOS (não-merged) como "donos" de um telefone.
      // Sem o `merged_into_id IS NULL`, um número que ainda mora num registro
      // duplicado/merged era devolvido como dono e bloqueava o worker legítimo
      // com PHONE_NOT_AVAILABLE — falso positivo causado pelas duplicatas
      // históricas de prod (mesmo número em formatos diferentes). Espelha o
      // predicado do idx_workers_phone_normalized (mig 219).
      const query = `
        SELECT id, auth_uid as "authUid", email, phone, country,
               created_at as "createdAt", updated_at as "updatedAt"
        FROM workers
        WHERE phone = ANY($1::text[])
          AND merged_into_id IS NULL
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
    const newStatus = await _recalculateStatus(this.pool, workerId, (id, s) => this.updateStatus(id, s));

    // Quando o status transitou para REGISTERED: enfileira mirror event (outbox best-effort).
    // Esta é a forma canônica de disparar o sync para AnaCare — todos os caminhos que
    // promovem um worker a REGISTERED passam por recalculateStatus.
    if (newStatus === 'REGISTERED') {
      await this.enqueueMirrorEvent(workerId);
    }

    return newStatus;
  }

  /**
   * Enfileira worker.mirror_requested no outbox (domain_events).
   * Best-effort: falha silenciosa — não bloqueia o fluxo principal.
   * Não é transacional com o UPDATE de status (pool.query direto, sem client).
   * Se o INSERT falhar não há linha pra reprocessar (o sweep do
   * DomainEventProcessor só reenfileira eventos JÁ gravados) — a rede de
   * segurança real é o BackfillWorkerMirrorUseCase, re-rodável a qualquer momento.
   */
  private async enqueueMirrorEvent(workerId: string): Promise<void> {
    try {
      const traceId = loggingAls.getStore()?.traceId ?? null;
      await this.pool.query(
        `INSERT INTO domain_events (event, payload, trace_id)
         VALUES ('worker.mirror_requested', $1::jsonb, $2)`,
        [JSON.stringify({ workerId }), traceId],
      );
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.child({ workerId }).warn({
        msg: '[WorkerRepository] failed to enqueue mirror event (best-effort, ignoring)',
        error: e.message,
      });
    }
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
