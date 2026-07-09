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

/**
 * Shape retornado por listByVacancy — campos necessários para os cards do kanban INICIADO.
 * workerId retornado em plaintext (sem decrypt — o controller cuida do KMS).
 */
export interface BlockedAttemptForFunnelDto {
  id: string;
  workerId: string | null;
  blockedReason: string;
  missingFields: string[];
  attemptCount: number;
  acquisitionChannel: string | null;
  lastAttemptedAt: string;
  /** Notas escritas enquanto o card estava bloqueado (migration 235 — chave estável worker_id+job_posting_id). */
  contactNotesCount: number;
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
        -- Recompute ON-READ (mesmo motivo do listByVacancy): o snapshot só é
        -- atualizado numa nova tentativa; recalcula ao vivo p/ registro incompleto.
        CASE
          WHEN wba.blocked_reason = 'registration_incomplete' AND wba.worker_id IS NOT NULL
          THEN fn_worker_missing_fields(wba.worker_id)
          ELSE wba.missing_fields
        END AS missing_fields,
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

  /**
   * Lista tentativas bloqueadas para uma vaga específica, excluindo workers que já têm WJA
   * para o mesmo par (worker_id, job_posting_id) — dedup via NOT EXISTS.
   *
   * Usado pelo WJAFunnelController para montar a coluna "INICIADO" do kanban.
   * Não faz decrypt de PII — o controller realiza o KMS decrypt em Promise.all junto
   * com os cards WJA normais.
   */
  async listByVacancy(jobPostingId: string): Promise<BlockedAttemptForFunnelDto[]> {
    const result = await this.pool.query(
      `SELECT
         wba.id,
         wba.worker_id,
         wba.blocked_reason,
         -- missing_fields recomputado ON-READ: o snapshot materializado só é
         -- atualizado numa nova tentativa de postulação, então editar o perfil
         -- do worker (nome, doc, etc.) não zerava as tags. Recalcula ao vivo via
         -- SSOT fn_worker_missing_fields quando o worker existe e o motivo é
         -- registro incompleto; demais reasons mantêm o snapshot.
         CASE
           WHEN wba.blocked_reason = 'registration_incomplete' AND wba.worker_id IS NOT NULL
           THEN fn_worker_missing_fields(wba.worker_id)
           ELSE wba.missing_fields
         END AS missing_fields,
         wba.attempt_count,
         wba.acquisition_channel,
         wba.last_attempted_at,
         (SELECT COUNT(*)::int FROM wja_contact_notes cn
          WHERE cn.worker_id = wba.worker_id AND cn.job_posting_id = wba.job_posting_id) AS contact_notes_count
       FROM worker_blocked_applications wba
       WHERE wba.job_posting_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM worker_job_applications wja
           WHERE wja.worker_id  = wba.worker_id
             AND wja.job_posting_id = wba.job_posting_id
         )
       ORDER BY wba.last_attempted_at DESC`,
      [jobPostingId],
    );

    return result.rows.map(r => ({
      id:                r.id as string,
      workerId:          (r.worker_id as string | null) ?? null,
      blockedReason:     r.blocked_reason as string,
      missingFields:     Array.isArray(r.missing_fields) ? r.missing_fields as string[] : [],
      attemptCount:      r.attempt_count as number,
      acquisitionChannel: (r.acquisition_channel as string | null) ?? null,
      lastAttemptedAt:   (r.last_attempted_at as Date).toISOString(),
      contactNotesCount: Number(r.contact_notes_count ?? 0),
    }));
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
