import * as crypto from 'crypto';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';
import { ApplicationFunnelStage } from '../domain/WorkerJobApplication';
import { WorkerEngagement } from '../domain/WorkerEngagement';
import { deriveKanbanColumn } from '../domain/kanbanColumn';

// =====================================================
// WorkerApplicationRepository
// Gerencia vínculos entre workers e job postings (pre-screenings do Talent Search)
// Migration 011 cria a tabela worker_job_applications
// Migration 019 adiciona a coluna source
// =====================================================
export class WorkerApplicationRepository {
  private pool: Pool;
  private _hasSourceColumn: boolean | null = null;

  constructor() { this.pool = DatabaseConnection.getInstance().getPool(); }

  private async hasSourceColumn(): Promise<boolean> {
    if (this._hasSourceColumn !== null) return this._hasSourceColumn;

    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'worker_job_applications'
         AND column_name = 'source'
       ) as exists`,
    );
    this._hasSourceColumn = result.rows[0].exists as boolean;
    return this._hasSourceColumn;
  }

  async upsert(
    workerId: string,
    jobPostingId: string,
    source = 'talent_search',
    funnelStage: ApplicationFunnelStage,
  ): Promise<{ created: boolean }> {
    const hasSource = await this.hasSourceColumn();

    try {
      const result = hasSource
        ? await this.pool.query(
            `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (worker_id, job_posting_id) DO NOTHING
             RETURNING id`,
            [workerId, jobPostingId, funnelStage, source],
          )
        : await this.pool.query(
            `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
             VALUES ($1, $2, $3)
             ON CONFLICT (worker_id, job_posting_id) DO NOTHING
             RETURNING id`,
            [workerId, jobPostingId, funnelStage],
          );

      const created = (result.rowCount ?? 0) > 0;

      // Defesa em camadas (TD-036 Fase 2): criar encuadre mínimo explícito quando
      // um novo WJA é inserido via talent_search. Trigger da migration 189 cobre
      // o path como fallback, mas esta chamada usa import_source_audit='talent_search' para
      // rastreabilidade fina no campo import_source_audit da tabela encuadres.
      // WHERE NOT EXISTS guard — idempotente, preserva encuadres ricos pré-existentes.
      if (created) {
        const dedupHash = crypto.createHash('md5')
          .update(`talent-search|${workerId}|${jobPostingId}`)
          .digest('hex');

        await this.pool.query(
          `INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
           SELECT $1, $2, 'talent_search', $3
           WHERE NOT EXISTS (
             SELECT 1 FROM encuadres e
             WHERE e.worker_id = $1 AND e.job_posting_id = $2
           )
           ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
          [workerId, jobPostingId, dedupHash],
        );

        logger.info({
          msg: 'WorkerApplicationRepository.upsert: encuadre ensured for new WJA',
          workerId,
          jobPostingId,
          importSourceAudit: 'talent_search',
        });
      }

      return { created };
    } catch (err) {
      logger.error({
        msg: 'WorkerApplicationRepository.upsert: ERROR',
        workerId,
        jobPostingId,
        error: (err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
  }

  async findByWorkerId(
    workerId: string,
  ): Promise<{ jobPostingId: string; funnelStage: string; source: string | null }[]> {
    const result = await this.pool.query(
      `SELECT job_posting_id, application_funnel_stage, source
       FROM worker_job_applications
       WHERE worker_id = $1
       ORDER BY created_at DESC`,
      [workerId],
    );
    return result.rows.map(r => ({
      jobPostingId: r.job_posting_id,
      funnelStage: r.application_funnel_stage,
      source: r.source ?? null,
    }));
  }

  async countByJobPosting(jobPostingId: string, filters: { startDate?: string; endDate?: string } = {}): Promise<number> {
    const conditions: string[] = ['job_posting_id = $1'];
    const values: unknown[] = [jobPostingId];
    let idx = 2;

    if (filters.startDate) { conditions.push(`created_at >= $${idx++}`); values.push(filters.startDate); }
    if (filters.endDate)   { conditions.push(`created_at <= $${idx++}`); values.push(filters.endDate); }

    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM worker_job_applications WHERE ${conditions.join(' AND ')}`,
      values
    );
    return (result.rows[0]?.count as number) ?? 0;
  }

  async countCandidatesByCaseNumber(country: string = 'AR'): Promise<Record<string, number>> {
    const result = await this.pool.query(
      `SELECT jp.case_number, COUNT(DISTINCT wja.worker_id)::int AS count
       FROM worker_job_applications wja
       JOIN job_postings jp ON wja.job_posting_id = jp.id
       JOIN workers w ON wja.worker_id = w.id
       WHERE jp.country = $1
         AND jp.deleted_at IS NULL
         AND w.status = 'INCOMPLETE_REGISTER'
       GROUP BY jp.case_number`,
      [country]
    );
    const map: Record<string, number> = {};
    for (const r of result.rows) {
      map[String(r.case_number)] = r.count as number;
    }
    return map;
  }

  async countPostuladosByCaseNumber(country: string = 'AR'): Promise<Record<string, number>> {
    const result = await this.pool.query(
      `SELECT jp.case_number, COUNT(DISTINCT wja.worker_id)::int AS count
       FROM worker_job_applications wja
       JOIN job_postings jp ON wja.job_posting_id = jp.id
       JOIN workers w ON wja.worker_id = w.id
       WHERE jp.country = $1
         AND jp.deleted_at IS NULL
         AND w.status = 'REGISTERED'
       GROUP BY jp.case_number`,
      [country]
    );
    const map: Record<string, number> = {};
    for (const r of result.rows) {
      map[String(r.case_number)] = r.count as number;
    }
    return map;
  }

  /**
   * Lista vagas ativas para um worker, excluindo stages de rejeição.
   * Inclui city via patient_address e search_start_date da vaga.
   */
  async findActiveByWorkerId(workerId: string): Promise<Array<{
    id: string;
    title: string;
    status: string;
    city?: string;
    startDate?: string;
    funnelStage: string;
  }>> {
    const result = await this.pool.query(
      `SELECT
         jp.id,
         jp.title,
         jp.status,
         pa.city,
         jp.search_start_date::TEXT AS start_date,
         wja.application_funnel_stage AS funnel_stage
       FROM worker_job_applications wja
       JOIN job_postings jp ON jp.id = wja.job_posting_id
       LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
       WHERE wja.worker_id = $1
         AND wja.application_funnel_stage NOT IN ('REJECTED', 'NOT_QUALIFIED')
         AND jp.deleted_at IS NULL
       ORDER BY jp.created_at DESC`,
      [workerId],
    );

    return result.rows.map(r => ({
      id: r.id as string,
      title: r.title as string,
      status: r.status as string,
      city: (r.city as string | null) ?? undefined,
      startDate: (r.start_date as string | null) ?? undefined,
      funnelStage: r.funnel_stage as string,
    }));
  }

  /**
   * Lista TODAS as WJA de um worker (sem filtro de rejeição — a aba de encuadre do
   * worker-detail deve mostrar a realidade, inclusive REJECTED), enriquecidas com o
   * encuadre mais recente do par (worker, vaga) e mapeadas para WorkerEngagement.
   *
   * kanbanStage é derivado por deriveKanbanColumn (SSOT compartilhada com o Kanban da
   * vaga), então a coluna exibida na ficha do prestador bate 1:1 com o board.
   * Blocked attempts NÃO entram aqui — o builder concatena BlockedApplicationQueryRepository.listByWorker.
   */
  async listEngagementsByWorker(workerId: string): Promise<WorkerEngagement[]> {
    const result = await this.pool.query(
      `SELECT
         wja.id,
         wja.job_posting_id,
         wja.application_funnel_stage AS funnel_stage,
         wja.source,
         jp.case_number,
         jp.vacancy_number,
         jp.status AS vacancy_status,
         p.first_name AS patient_first_name,
         p.last_name  AS patient_last_name,
         e.resultado,
         e.interview_date,
         e.interview_time,
         e.recruiter_name,
         e.coordinator_name,
         e.rejection_reason,
         e.rejection_reason_category,
         e.attended,
         COALESCE(e.created_at, wja.created_at) AS created_at
       FROM worker_job_applications wja
       LEFT JOIN job_postings jp ON jp.id = wja.job_posting_id
       LEFT JOIN patients p ON jp.patient_id = p.id
       LEFT JOIN LATERAL (
         SELECT id, resultado, interview_date, interview_time, recruiter_name,
                coordinator_name, rejection_reason, rejection_reason_category, attended, created_at
         FROM encuadres
         WHERE worker_id = wja.worker_id AND job_posting_id = wja.job_posting_id
         ORDER BY created_at DESC
         LIMIT 1
       ) e ON true
       WHERE wja.worker_id = $1
       ORDER BY COALESCE(e.created_at, wja.created_at) DESC`,
      [workerId],
    );

    return result.rows.map((r): WorkerEngagement => ({
      id: r.id as string,
      jobPostingId: (r.job_posting_id as string | null) ?? null,
      caseNumber: (r.case_number as number | null) ?? null,
      vacancyNumber: (r.vacancy_number as number | null) ?? null,
      patientName: [r.patient_first_name, r.patient_last_name].filter(Boolean).join(' ') || null,
      vacancyStatus: (r.vacancy_status as string | null) ?? null,
      kanbanStage: deriveKanbanColumn(
        (r.funnel_stage as string | null) ?? null,
        (r.source as string | null) ?? null,
      ),
      resultado: (r.resultado as string | null) ?? null,
      interviewDate: (r.interview_date as string | null) ?? null,
      interviewTime: (r.interview_time as string | null) ?? null,
      recruiterName: (r.recruiter_name as string | null) ?? null,
      coordinatorName: (r.coordinator_name as string | null) ?? null,
      rejectionReason: (r.rejection_reason as string | null) ?? null,
      rejectionReasonCategory: (r.rejection_reason_category as string | null) ?? null,
      attended: (r.attended as boolean | null) ?? null,
      isBlocked: false,
      blockedReason: null,
      missingFields: [],
      attemptCount: null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }
}
