import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export interface BlockedAttemptDto {
  id: string;
  workerId: string;
  jobPostingId: string;
  blockedReason: string;
  missingFields: string[];
  attemptCount: number;
  firstAttemptedAt: string;
  lastAttemptedAt: string;
  acquisitionChannel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlockedAggregates {
  totalBlocked: number;
  byReason: Record<string, number>;
}

export interface ListBlockedAttemptsParams {
  jobPostingId?: string;
  workerId?: string;
  reason?: string;
  limit: number;
  offset: number;
}

export interface ListBlockedAttemptsResult {
  data: BlockedAttemptDto[];
  total: number;
}

/**
 * BlockedApplicationQueryRepository (read side)
 *
 * Leitura de worker_blocked_applications para o endpoint de operadores.
 * CQRS leve: separado de BlockedApplicationRepository (write side).
 * Migration 209.
 */
export class BlockedApplicationQueryRepository {
  private readonly pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async list(params: ListBlockedAttemptsParams): Promise<ListBlockedAttemptsResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (params.jobPostingId) {
      conditions.push(`wba.job_posting_id = $${idx++}`);
      values.push(params.jobPostingId);
    }
    if (params.workerId) {
      conditions.push(`wba.worker_id = $${idx++}`);
      values.push(params.workerId);
    }
    if (params.reason) {
      conditions.push(`wba.blocked_reason = $${idx++}`);
      values.push(params.reason);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const dataQuery = `
      SELECT
        wba.id,
        wba.worker_id,
        wba.job_posting_id,
        wba.blocked_reason,
        wba.missing_fields,
        wba.attempt_count,
        wba.first_attempted_at,
        wba.last_attempted_at,
        wba.acquisition_channel,
        wba.created_at,
        wba.updated_at
      FROM worker_blocked_applications wba
      ${whereClause}
      ORDER BY wba.last_attempted_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM worker_blocked_applications wba
      ${whereClause}
    `;

    const dataValues = [...values, params.limit, params.offset];
    const countValues = [...values];

    const [dataResult, countResult] = await Promise.all([
      this.pool.query(dataQuery, dataValues),
      this.pool.query(countQuery, countValues),
    ]);

    const data: BlockedAttemptDto[] = dataResult.rows.map(r => ({
      id: r.id as string,
      workerId: r.worker_id as string,
      jobPostingId: r.job_posting_id as string,
      blockedReason: r.blocked_reason as string,
      missingFields: Array.isArray(r.missing_fields) ? r.missing_fields as string[] : [],
      attemptCount: r.attempt_count as number,
      firstAttemptedAt: (r.first_attempted_at as Date).toISOString(),
      lastAttemptedAt: (r.last_attempted_at as Date).toISOString(),
      acquisitionChannel: (r.acquisition_channel as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    }));

    return {
      data,
      total: (countResult.rows[0]?.total as number) ?? 0,
    };
  }

  async aggregates(): Promise<BlockedAggregates> {
    const result = await this.pool.query<{ blocked_reason: string; count: number }>(
      `SELECT blocked_reason, COUNT(*)::int AS count
       FROM worker_blocked_applications
       GROUP BY blocked_reason`,
    );

    const byReason: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows) {
      byReason[row.blocked_reason] = row.count;
      total += row.count;
    }

    return { totalBlocked: total, byReason };
  }
}
