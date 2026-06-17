import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';

export interface BlockedApplicationUpsertParams {
  workerId: string;
  jobPostingId: string;
  reason: 'worker_not_found' | 'registration_incomplete' | 'worker_disabled';
  acquisitionChannel: string | null;
}

export interface BlockedApplicationRow {
  id: string;
  worker_id: string;
  job_posting_id: string;
  blocked_reason: string;
  missing_fields: string[];
  attempt_count: number;
  first_attempted_at: Date;
  last_attempted_at: Date;
  acquisition_channel: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * BlockedApplicationRepository (write side)
 *
 * Persiste tentativas de postulação bloqueadas em worker_blocked_applications.
 * Invoca fn_worker_missing_fields() para popular missing_fields.
 *
 * CQRS leve: este repositório só escreve. Leitura via BlockedApplicationQueryRepository.
 *
 * Sem FK para workers/job_postings — tolera merges e soft-deletes.
 * Migration 209.
 */
export class BlockedApplicationRepository {
  private readonly pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Upsert de tentativa bloqueada.
   *
   * - Na primeira tentativa: INSERT com attempt_count=1.
   * - Em retentativas: incrementa attempt_count, atualiza last_attempted_at,
   *   recalcula missing_fields, preserva acquisition_channel (first-value-wins).
   */
  async upsert(params: BlockedApplicationUpsertParams): Promise<void> {
    const log = logger.child({
      workerId: params.workerId,
      jobPostingId: params.jobPostingId,
      reason: params.reason,
    });

    // Calcula missing_fields via SSOT SQL para worker_not_found e registration_incomplete.
    // Para worker_disabled retorna [] (worker existe mas está desabilitado — campos irrelevantes).
    let missingFields: string[] = [];
    if (params.reason !== 'worker_disabled') {
      const { rows } = await this.pool.query<{ missing: string[] }>(
        `SELECT fn_worker_missing_fields($1)::text AS missing`,
        [params.workerId],
      );
      const raw = rows[0]?.missing;
      if (typeof raw === 'string') {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            missingFields = parsed.filter((v): v is string => typeof v === 'string');
          }
        } catch {
          log.warn({ msg: 'BlockedApplicationRepository: failed to parse fn_worker_missing_fields result', raw });
        }
      } else if (Array.isArray(raw)) {
        missingFields = (raw as unknown[]).filter((v): v is string => typeof v === 'string');
      }
    }

    await this.pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason, missing_fields, acquisition_channel,
          attempt_count, first_attempted_at, last_attempted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 1, NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
         attempt_count        = worker_blocked_applications.attempt_count + 1,
         last_attempted_at    = NOW(),
         missing_fields       = EXCLUDED.missing_fields,
         blocked_reason       = EXCLUDED.blocked_reason,
         acquisition_channel  = COALESCE(
                                  worker_blocked_applications.acquisition_channel,
                                  EXCLUDED.acquisition_channel
                                ),
         updated_at           = NOW()`,
      [
        params.workerId,
        params.jobPostingId,
        params.reason,
        JSON.stringify(missingFields),
        params.acquisitionChannel,
      ],
    );

    log.info({
      msg: 'BlockedApplicationRepository.upsert: blocked attempt recorded',
      missingFieldsCount: missingFields.length,
    });
  }
}
