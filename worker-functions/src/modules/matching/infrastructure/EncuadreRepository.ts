import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  Encuadre,
  CreateEncuadreDTO,
  EncuadreFilters,
  SupplementEncuadreDTO,
  RejectionReasonCategory,
} from '../domain/Encuadre';
import { mapEncuadreRow, buildEncuadreWhereClause } from './EncuadreMappers';

// Re-exports: todos os consumidores existentes só importam EncuadreRepository,
// por isso os métodos de query são herdados diretamente na classe abaixo.
export { EncuadreQueryRepository } from './EncuadreQueryRepository';
export { mapEncuadreRow, buildEncuadreWhereClause } from './EncuadreMappers';

// Silence unused-import warnings — EncuadreFilters/SupplementEncuadreDTO/RejectionReasonCategory
// são re-exportados via barrel para consumers que os importem daqui.
export type {
  Encuadre,
  CreateEncuadreDTO,
  EncuadreFilters,
  SupplementEncuadreDTO,
  RejectionReasonCategory,
} from '../domain/Encuadre';

export class EncuadreRepository {
  protected pool: Pool;
  protected encryptionService: KMSEncryptionService;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  async upsert(dto: CreateEncuadreDTO): Promise<{ encuadre: Encuadre; created: boolean }> {
    // ON CONFLICT rules:
    //   resultado / attended / accepts_case / rejection_reason → always overwrite
    //   obs_* → always overwrite
    //   meet_link / origen / id_onboarding / worker_email_encrypted → COALESCE
    //   llm_processed_at → nulled if obs changed (forces re-processing)
    const workerEmailEnc = await this.encryptionService.encrypt(dto.workerEmail ?? null);

    const query = `
      INSERT INTO encuadres (
        worker_id, job_posting_id,
        worker_raw_name, worker_raw_phone, occupation_raw,
        recruiter_name, coordinator_name, recruitment_date,
        interview_date, interview_time, meet_link,
        attended, absence_reason,
        accepts_case, rejection_reason, rejection_reason_category, resultado, redireccionamiento,
        has_cv, has_dni, has_cert_at, has_afip, has_cbu, has_ap, has_seguros,
        worker_email_encrypted,
        obs_reclutamiento, obs_encuadre, obs_adicionales,
        origen, id_onboarding,
        dedup_hash
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
      )
      ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
        resultado          = EXCLUDED.resultado,
        attended           = EXCLUDED.attended,
        accepts_case       = EXCLUDED.accepts_case,
        rejection_reason   = EXCLUDED.rejection_reason,
        rejection_reason_category = EXCLUDED.rejection_reason_category,
        redireccionamiento = EXCLUDED.redireccionamiento,
        absence_reason     = EXCLUDED.absence_reason,
        has_cv             = EXCLUDED.has_cv,
        has_dni            = EXCLUDED.has_dni,
        has_cert_at        = EXCLUDED.has_cert_at,
        has_afip           = EXCLUDED.has_afip,
        has_cbu            = EXCLUDED.has_cbu,
        has_ap             = EXCLUDED.has_ap,
        has_seguros        = EXCLUDED.has_seguros,
        obs_reclutamiento  = EXCLUDED.obs_reclutamiento,
        obs_encuadre       = EXCLUDED.obs_encuadre,
        obs_adicionales    = EXCLUDED.obs_adicionales,
        meet_link          = COALESCE(encuadres.meet_link,      EXCLUDED.meet_link),
        origen             = COALESCE(encuadres.origen,         EXCLUDED.origen),
        id_onboarding      = COALESCE(encuadres.id_onboarding,  EXCLUDED.id_onboarding),
        worker_email_encrypted = COALESCE(encuadres.worker_email_encrypted, EXCLUDED.worker_email_encrypted),
        updated_at = NOW()
      RETURNING *, (xmax = 0) AS inserted
    `;

    const values = [
      dto.workerId ?? null, dto.jobPostingId ?? null,
      dto.workerRawName ?? null, dto.workerRawPhone ?? null, dto.occupationRaw ?? null,
      dto.recruiterName ?? null, dto.coordinatorName ?? null, dto.recruitmentDate ?? null,
      dto.interviewDate ?? null, dto.interviewTime ?? null, dto.meetLink ?? null,
      dto.attended ?? null, dto.absenceReason ?? null,
      dto.acceptsCase ?? null, dto.rejectionReason ?? null, dto.rejectionReasonCategory ?? null,
      dto.resultado ?? null, dto.redireccionamiento ?? null,
      dto.hasCv ?? null, dto.hasDni ?? null, dto.hasCertAt ?? null,
      dto.hasAfip ?? null, dto.hasCbu ?? null, dto.hasAp ?? null, dto.hasSeguros ?? null,
      workerEmailEnc,
      dto.obsReclutamiento ?? null, dto.obsEncuadre ?? null, dto.obsAdicionales ?? null,
      dto.origen ?? null, dto.idOnboarding ?? null, dto.dedupHash,
    ];

    const result = await this.pool.query(query, values);
    const created = result.rows[0]?.inserted ?? false;
    return { encuadre: await mapEncuadreRow(result.rows[0], this.encryptionService), created };
  }

  async bulkUpsert(dtos: CreateEncuadreDTO[]): Promise<{ created: number; updated: number }> {
    if (dtos.length === 0) return { created: 0, updated: 0 };

    const encryptedEmails = await Promise.all(
      dtos.map(d => this.encryptionService.encrypt(d.workerEmail ?? null))
    );

    const query = `
      INSERT INTO encuadres (
        worker_id, job_posting_id,
        worker_raw_name, worker_raw_phone, occupation_raw,
        recruiter_name, coordinator_name, recruitment_date,
        interview_date, interview_time, meet_link,
        attended, absence_reason,
        accepts_case, rejection_reason, rejection_reason_category, resultado, redireccionamiento,
        has_cv, has_dni, has_cert_at, has_afip, has_cbu, has_ap, has_seguros,
        worker_email_encrypted,
        obs_reclutamiento, obs_encuadre, obs_adicionales,
        origen, id_onboarding, dedup_hash
      )
      SELECT
        UNNEST($1::uuid[]),  UNNEST($2::uuid[]),
        UNNEST($3::text[]),  UNNEST($4::text[]),  UNNEST($5::text[]),
        UNNEST($6::text[]),  UNNEST($7::text[]),  UNNEST($8::date[]),
        UNNEST($9::date[]),  NULLIF(UNNEST($10::text[]), '')::time, UNNEST($11::text[]),
        UNNEST($12::boolean[]), UNNEST($13::text[]),
        UNNEST($14::text[]), UNNEST($15::text[]), UNNEST($16::text[]), UNNEST($17::text[]), UNNEST($18::text[]),
        UNNEST($19::boolean[]), UNNEST($20::boolean[]), UNNEST($21::boolean[]),
        UNNEST($22::boolean[]), UNNEST($23::boolean[]), UNNEST($24::boolean[]), UNNEST($25::boolean[]),
        UNNEST($26::text[]),
        UNNEST($27::text[]), UNNEST($28::text[]), UNNEST($29::text[]),
        UNNEST($30::text[]), UNNEST($31::text[]), UNNEST($32::text[])
      ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
        resultado          = EXCLUDED.resultado,
        attended           = EXCLUDED.attended,
        accepts_case       = EXCLUDED.accepts_case,
        rejection_reason   = EXCLUDED.rejection_reason,
        rejection_reason_category = EXCLUDED.rejection_reason_category,
        redireccionamiento = EXCLUDED.redireccionamiento,
        absence_reason     = EXCLUDED.absence_reason,
        has_cv = EXCLUDED.has_cv, has_dni = EXCLUDED.has_dni,
        has_cert_at = EXCLUDED.has_cert_at, has_afip = EXCLUDED.has_afip,
        has_cbu = EXCLUDED.has_cbu, has_ap = EXCLUDED.has_ap, has_seguros = EXCLUDED.has_seguros,
        obs_reclutamiento  = EXCLUDED.obs_reclutamiento,
        obs_encuadre       = EXCLUDED.obs_encuadre,
        obs_adicionales    = EXCLUDED.obs_adicionales,
        meet_link     = COALESCE(encuadres.meet_link,     EXCLUDED.meet_link),
        origen        = COALESCE(encuadres.origen,        EXCLUDED.origen),
        id_onboarding = COALESCE(encuadres.id_onboarding, EXCLUDED.id_onboarding),
        worker_email_encrypted = COALESCE(encuadres.worker_email_encrypted, EXCLUDED.worker_email_encrypted),
        updated_at = NOW()
      RETURNING (xmax = 0) AS inserted
    `;

    const result = await this.pool.query(query, [
      dtos.map(d => d.workerId ?? null),       dtos.map(d => d.jobPostingId ?? null),
      dtos.map(d => d.workerRawName ?? null),  dtos.map(d => d.workerRawPhone ?? null),
      dtos.map(d => d.occupationRaw ?? null),  dtos.map(d => d.recruiterName ?? null),
      dtos.map(d => d.coordinatorName ?? null),dtos.map(d => d.recruitmentDate ?? null),
      dtos.map(d => d.interviewDate ?? null),  dtos.map(d => d.interviewTime ?? null),
      dtos.map(d => d.meetLink ?? null),       dtos.map(d => d.attended ?? null),
      dtos.map(d => d.absenceReason ?? null),  dtos.map(d => d.acceptsCase ?? null),
      dtos.map(d => d.rejectionReason ?? null),dtos.map(d => d.rejectionReasonCategory ?? null),
      dtos.map(d => d.resultado ?? null),      dtos.map(d => d.redireccionamiento ?? null),
      dtos.map(d => d.hasCv ?? null),          dtos.map(d => d.hasDni ?? null),
      dtos.map(d => d.hasCertAt ?? null),      dtos.map(d => d.hasAfip ?? null),
      dtos.map(d => d.hasCbu ?? null),         dtos.map(d => d.hasAp ?? null),
      dtos.map(d => d.hasSeguros ?? null),     encryptedEmails,
      dtos.map(d => d.obsReclutamiento ?? null),dtos.map(d => d.obsEncuadre ?? null),
      dtos.map(d => d.obsAdicionales ?? null), dtos.map(d => d.origen ?? null),
      dtos.map(d => d.idOnboarding ?? null),   dtos.map(d => d.dedupHash),
    ]);

    const created = result.rows.filter(r => r.inserted).length;
    return { created, updated: result.rows.length - created };
  }

  /**
   * @deprecated F6 (2026-05-24): pipeline reverso encuadres → WJA está deprecado.
   * WJA é SSOT do funil, populada via webhook Talentum / matchmaking / self-service.
   * Mantido apenas como referência histórica + backfill one-shot manual se necessário.
   * Ver docs/features/worker-job-applications/README.md e ADR-002.
   *
   * NÃO chamar em código novo. NÃO chamar em pipelines recorrentes.
   */
  async syncToWorkerJobApplications(): Promise<number> {
    const result = await this.pool.query(`
      INSERT INTO worker_job_applications (
        worker_id, job_posting_id,
        application_status, application_funnel_stage,
        applied_at, rejection_reason, source
      )
      SELECT
        e.worker_id, e.job_posting_id,
        CASE
          WHEN e.resultado IN ('SELECCIONADO', 'REEMPLAZO') THEN 'approved'
          WHEN e.resultado IN ('RECHAZADO', 'AT_NO_ACEPTA', 'BLACKLIST') THEN 'rejected'
          WHEN e.resultado = 'REPROGRAMAR' THEN 'interview_scheduled'
          WHEN e.resultado IS NOT NULL OR e.attended = true THEN 'under_review'
          ELSE 'applied'
        END,
        CASE
          WHEN e.resultado IN ('SELECCIONADO', 'REEMPLAZO') THEN 'QUALIFIED'
          WHEN e.resultado IN ('RECHAZADO', 'AT_NO_ACEPTA', 'BLACKLIST') THEN 'REJECTED'
          WHEN e.attended = true THEN 'IN_PROGRESS'
          WHEN e.interview_date IS NOT NULL OR e.resultado = 'REPROGRAMAR' THEN 'IN_PROGRESS'
          ELSE 'INITIATED'
        END,
        COALESCE(e.recruitment_date::timestamptz, e.created_at),
        e.rejection_reason,
        'planilla_operativa'
      FROM (
        SELECT DISTINCT ON (worker_id, job_posting_id)
          worker_id, job_posting_id, resultado, attended,
          interview_date, recruitment_date, created_at, rejection_reason
        FROM encuadres
        WHERE worker_id IS NOT NULL AND job_posting_id IS NOT NULL
        ORDER BY worker_id, job_posting_id,
          CASE resultado
            WHEN 'SELECCIONADO' THEN 1 WHEN 'REEMPLAZO' THEN 2
            WHEN 'RECHAZADO' THEN 3 WHEN 'AT_NO_ACEPTA' THEN 4 WHEN 'BLACKLIST' THEN 5
            WHEN 'REPROGRAMAR' THEN 6 ELSE 7
          END,
          COALESCE(recruitment_date, created_at::date) DESC NULLS LAST
      ) e
      ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
        application_status       = EXCLUDED.application_status,
        application_funnel_stage = CASE
          WHEN funnel_stage_precedence(EXCLUDED.application_funnel_stage)
               >= funnel_stage_precedence(worker_job_applications.application_funnel_stage)
          THEN EXCLUDED.application_funnel_stage
          ELSE worker_job_applications.application_funnel_stage
        END,
        rejection_reason = COALESCE(EXCLUDED.rejection_reason, worker_job_applications.rejection_reason),
        updated_at = NOW()
    `);
    return result.rowCount ?? 0;
  }

  // ── Delegated query methods (kept on EncuadreRepository for backward compat) ──

  async findSoftMatch(jobPostingId: string, phone: string, interviewDate: Date | null, recruitmentDate: Date | null): Promise<Encuadre | null> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().findSoftMatch(jobPostingId, phone, interviewDate, recruitmentDate);
  }

  async updateSupplement(id: string, dto: SupplementEncuadreDTO): Promise<void> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().updateSupplement(id, dto);
  }

  async findByDedupHash(hash: string): Promise<Encuadre | null> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().findByDedupHash(hash);
  }

  async findByWorkerId(workerId: string): Promise<Encuadre[]> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().findByWorkerId(workerId);
  }

  async findByJobPostingId(jobPostingId: string): Promise<Encuadre[]> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().findByJobPostingId(jobPostingId);
  }

  async linkWorkersByPhone(): Promise<number> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().linkWorkersByPhone();
  }

  async countByFilters(filters: EncuadreFilters): Promise<number> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().countByFilters(filters);
  }

  async countAttended(filters: { startDate?: string; endDate?: string; country?: string } = {}): Promise<number> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().countAttended(filters);
  }

  async countCandidatesByJobPosting(jobPostingId: string, filters: { startDate?: string; endDate?: string } = {}): Promise<number> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().countCandidatesByJobPosting(jobPostingId, filters);
  }

  async countInvitedAndAttended(jobPostingId: string, filters: { startDate?: string; endDate?: string } = {}): Promise<{ invitados: number; asistentes: number }> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().countInvitedAndAttended(jobPostingId, filters);
  }

  async countByResultado(jobPostingId: string, filters: { startDate?: string; endDate?: string } = {}): Promise<Array<{ resultado: string; count: number }>> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().countByResultado(jobPostingId, filters);
  }

  async countSelAndRemByCaseNumber(country: string = 'AR'): Promise<Record<string, { sel: number; rem: number }>> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().countSelAndRemByCaseNumber(country);
  }

  async getWorkerRejectionHistory(workerId: string): Promise<Record<string, number>> {
    const { EncuadreQueryRepository } = await import('./EncuadreQueryRepository');
    return new EncuadreQueryRepository().getWorkerRejectionHistory(workerId);
  }
}
