import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { WorkerEngagement } from '../domain/WorkerEngagement';
import { KANBAN_COLUMN_BLOCKED } from '../domain/kanbanColumn';
import {
  liveWorkerJoinSql,
  liveBlockedReasonSql,
  liveMissingFieldsSql,
  type BlockedAttemptLiveState,
} from './blockedAttemptLiveState';

export interface BlockedAttemptDto {
  id: string;
  workerId: string;
  jobPostingId: string;
  /** Estado AO VIVO, recalculado na leitura — inclui `eligible`. Ver `blockedAttemptLiveState`. */
  blockedReason: BlockedAttemptLiveState;
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
  /** Estado AO VIVO, recalculado na leitura — inclui `eligible`. Ver `blockedAttemptLiveState`. */
  blockedReason: BlockedAttemptLiveState;
  missingFields: string[];
  attemptCount: number;
  acquisitionChannel: string | null;
  lastAttemptedAt: string;
  /** Notas escritas enquanto o card estava bloqueado (migration 235 — chave estável worker_id+job_posting_id). */
  contactNotesCount: number;
  /** Soft-dismiss (migration 250): quando "rechazado" no kanban. null = ativo em BLOQUEADO, senão vai p/ RECHAZADOS. */
  dismissedAt: string | null;
  /** Categoria do motivo do rechazo (enum rejection_reason_category). null quando não rechazado. */
  dismissedReason: string | null;
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
    // Só tentativas ativas — as "rechazadas" (soft-dismiss, migration 250) saem do painel.
    const conditions: string[] = ['wba.dismissed_at IS NULL'];
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
    // Filtra pelo motivo AO VIVO, não pelo congelado: filtrar por um valor que a
    // tela não exibe mais devolveria cards que contradizem o próprio filtro.
    if (params.reason) {
      conditions.push(`${liveBlockedReasonSql()} = $${idx++}`);
      values.push(params.reason);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const dataQuery = `
      SELECT
        wba.id,
        wba.worker_id,
        wba.job_posting_id,
        -- Motivo e campos recalculados ON-READ contra o estado de hoje (D300).
        ${liveBlockedReasonSql()} AS blocked_reason,
        ${liveMissingFieldsSql()} AS missing_fields,
        wba.attempt_count,
        wba.first_attempted_at,
        wba.last_attempted_at,
        wba.acquisition_channel,
        wba.created_at,
        wba.updated_at
      FROM worker_blocked_applications wba
      ${liveWorkerJoinSql()}
      ${whereClause}
      ORDER BY wba.last_attempted_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM worker_blocked_applications wba
      ${liveWorkerJoinSql()}
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
      blockedReason: r.blocked_reason as BlockedAttemptLiveState,
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
         -- Motivo E campos recomputados ON-READ (D300): o snapshot materializado
         -- só é reescrito numa nova tentativa, então tanto completar o perfil
         -- quanto ser reativado deixavam o card exibindo o rótulo de meses atrás.
         -- Recalcular só os campos — como se fazia — não alcançava o caso: o
         -- CASE antigo exigia que o motivo congelado JÁ fosse
         -- registration_incomplete, que é justamente quando ele não muda.
         ${liveBlockedReasonSql()} AS blocked_reason,
         ${liveMissingFieldsSql()} AS missing_fields,
         wba.attempt_count,
         wba.acquisition_channel,
         wba.last_attempted_at,
         wba.dismissed_at,
         wba.dismissed_reason,
         (SELECT COUNT(*)::int FROM wja_contact_notes cn
          WHERE cn.worker_id = wba.worker_id AND cn.job_posting_id = wba.job_posting_id) AS contact_notes_count
       FROM worker_blocked_applications wba
       ${liveWorkerJoinSql()}
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
      blockedReason:     r.blocked_reason as BlockedAttemptLiveState,
      missingFields:     Array.isArray(r.missing_fields) ? r.missing_fields as string[] : [],
      attemptCount:      r.attempt_count as number,
      acquisitionChannel: (r.acquisition_channel as string | null) ?? null,
      lastAttemptedAt:   (r.last_attempted_at as Date).toISOString(),
      contactNotesCount: Number(r.contact_notes_count ?? 0),
      dismissedAt:       r.dismissed_at ? (r.dismissed_at as Date).toISOString() : null,
      dismissedReason:   (r.dismissed_reason as string | null) ?? null,
    }));
  }

  /**
   * Lista tentativas bloqueadas de UM worker (todas as vagas), excluindo pares que já
   * viraram WJA real (NOT EXISTS — mesma dedup do listByVacancy). Enriquece com dados
   * da vaga/paciente para a aba de encuadre do worker-detail e mapeia para o shape
   * unificado WorkerEngagement (kanbanStage = BLOQUEADO).
   *
   * Motivo e missing_fields são recomputados ON-READ (`blockedAttemptLiveState`) —
   * editar o perfil do worker, ou ele ser reativado, reflete aqui sem nova tentativa.
   */
  async listByWorker(workerId: string): Promise<WorkerEngagement[]> {
    const result = await this.pool.query(
      `SELECT
         wba.id,
         wba.job_posting_id,
         jp.case_number,
         jp.vacancy_number,
         jp.status AS vacancy_status,
         p.first_name AS patient_first_name,
         p.last_name  AS patient_last_name,
         ${liveBlockedReasonSql()} AS blocked_reason,
         ${liveMissingFieldsSql()} AS missing_fields,
         wba.attempt_count,
         wba.created_at
       FROM worker_blocked_applications wba
       ${liveWorkerJoinSql()}
       LEFT JOIN job_postings jp ON jp.id = wba.job_posting_id
       LEFT JOIN patients p ON jp.patient_id = p.id
       WHERE wba.worker_id = $1
         AND wba.dismissed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM worker_job_applications wja
           WHERE wja.worker_id = wba.worker_id
             AND wja.job_posting_id = wba.job_posting_id
         )
       ORDER BY wba.last_attempted_at DESC`,
      [workerId],
    );

    return result.rows.map((r): WorkerEngagement => ({
      id: r.id as string,
      jobPostingId: (r.job_posting_id as string | null) ?? null,
      caseNumber: (r.case_number as number | null) ?? null,
      vacancyNumber: (r.vacancy_number as number | null) ?? null,
      patientName: [r.patient_first_name, r.patient_last_name].filter(Boolean).join(' ') || null,
      vacancyStatus: (r.vacancy_status as string | null) ?? null,
      kanbanStage: KANBAN_COLUMN_BLOCKED,
      resultado: null,
      interviewDate: null,
      interviewTime: null,
      recruiterName: null,
      coordinatorName: null,
      rejectionReason: null,
      rejectionReasonCategory: null,
      attended: null,
      isBlocked: true,
      blockedReason: (r.blocked_reason as string | null) ?? null,
      missingFields: Array.isArray(r.missing_fields) ? r.missing_fields as string[] : [],
      attemptCount: (r.attempt_count as number | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
    }));
  }

  /**
   * Contagem por motivo — também AO VIVO (D300). Se o agregado contasse o motivo
   * congelado enquanto a lista exibe o recalculado, o cabeçalho do painel
   * contradiria as linhas logo abaixo dele.
   */
  async aggregates(): Promise<BlockedAggregates> {
    const result = await this.pool.query<{ blocked_reason: string; count: number }>(
      `SELECT ${liveBlockedReasonSql()} AS blocked_reason, COUNT(*)::int AS count
       FROM worker_blocked_applications wba
       ${liveWorkerJoinSql()}
       WHERE wba.dismissed_at IS NULL
       GROUP BY 1`,
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
