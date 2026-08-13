/**
 * AnalyticsRepository
 *
 * Consultas de BI sobre workers e vagas. Usa as views criadas na migration 020:
 *   • v_job_posting_stats            — estatísticas por vaga
 *   • v_worker_registration_overview — visão completa do worker
 *   • v_potential_duplicate_workers  — candidatos a deduplicação
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { workerNotDisabledSql } from '@shared/database/activeWorkerFilter';

// ─── Tipos de retorno ──────────────────────────────────────────────────────

export interface WorkerCountStats {
  total: number;
  byWorkerStatus: Record<string, number>;
  registrationCompleted: number;
  registrationPending: number;
  missingDocuments: number;
}

export interface JobPostingStats {
  jobPostingId: string;
  caseNumber: number;
  patientName: string | null;
  caseStatus: string;
  priority: string | null;
  dependency: string | null;
  coordinatorName: string | null;
  isCovered: boolean;
  totalInterested: number;
  totalPreScreened: number;
  totalInterviewed: number;
  totalApproved: number;
  totalRejected: number;
  totalNoAcepta: number;
  totalPending: number;
  totalIncompleteRegistration: number;
}

export interface WorkerRegistrationStatus {
  workerId: string;
  email: string;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  workerStatus: string;
  registrationCompleted: boolean;
  currentStep: number;
  documentsStatus: string;
  /** Todas as outras vagas desse worker (exceto a consultada) */
  otherVacancies: Array<{
    jobPostingId: string;
    caseNumber: number | null;
    patientName: string | null;
    resultado: string | null;
    registrationCompleted: boolean;
  }>;
}

export interface WorkerMissingDocs {
  workerId: string;
  email: string;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  workerStatus: string;
  documentsStatus: string;
  totalVacanciesInterviewed: number;
  totalVacanciesApproved: number;
}

export interface WorkerVacancyEngagement {
  workerId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  registrationCompleted: boolean;
  vacancies: Array<{
    jobPostingId: string;
    caseNumber: number | null;
    patientName: string | null;
    caseStatus: string;
    resultado: string | null;
    attended: boolean | null;
    interviewDate: Date | null;
    registrationCompleted: boolean;
  }>;
}

export interface DuplicateCandidate {
  worker1Id: string;
  worker1Phone: string | null;
  worker1Email: string;
  worker1FirstName: string | null;
  worker1LastName: string | null;
  worker1Cuit: string | null;
  worker1Sources: string[];
  worker2Id: string;
  worker2Phone: string | null;
  worker2Email: string;
  worker2FirstName: string | null;
  worker2LastName: string | null;
  worker2Cuit: string | null;
  worker2Sources: string[];
  matchReason: 'cuit_match' | 'phone_similar' | 'phone_name_combined' | 'name_similar' | 'import_email_name_match';
}

// ─── Repository ────────────────────────────────────────────────────────────

export class AnalyticsRepository {
  private pool: Pool;
  private encryptionService: KMSEncryptionService;
  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  // ── 1. Totais de workers ──────────────────────────────────────────────────

  async countWorkers(): Promise<WorkerCountStats> {
    const [totalRes, stageRes, docsRes] = await Promise.all([
      this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE merged_into_id IS NULL)                                          AS total,
          COUNT(*) FILTER (WHERE merged_into_id IS NULL AND first_name_encrypted IS NOT NULL)     AS completed,
          COUNT(*) FILTER (WHERE merged_into_id IS NULL AND first_name_encrypted IS NULL)         AS pending
        FROM workers
      `),
      this.pool.query(`
        SELECT status, COUNT(*) AS cnt
        FROM workers
        WHERE merged_into_id IS NULL
        GROUP BY status
      `),
      this.pool.query(`
        SELECT COUNT(DISTINCT w.id) AS missing
        FROM workers w
        LEFT JOIN worker_documents wd ON w.id = wd.worker_id
        WHERE w.merged_into_id IS NULL
          AND (wd.documents_status IS NULL OR wd.documents_status NOT IN ('submitted','verified'))
      `),
    ]);

    const row = totalRes.rows[0];
    const byWorkerStatus: Record<string, number> = {};
    for (const r of stageRes.rows) {
      byWorkerStatus[r.status ?? 'null'] = parseInt(r.cnt);
    }

    return {
      total: parseInt(row.total),
      byWorkerStatus,
      registrationCompleted: parseInt(row.completed),
      registrationPending:   parseInt(row.pending),
      missingDocuments:      parseInt(docsRes.rows[0].missing),
    };
  }

  // ── 2. Estatísticas de uma vaga ───────────────────────────────────────────

  /** Inline query replacing the dropped v_job_posting_stats view (migration 040 dropped patient_name) */
  private get jobPostingStatsQuery(): string {
    return `
      SELECT
        jp.id AS job_posting_id,
        jp.case_number,
        p.first_name AS patient_name,
        jp.status AS case_status,
        jp.priority,
        p.dependency_level AS dependency,
        jp.coordinator_name,
        jp.is_covered,
        (SELECT COUNT(DISTINCT worker_id) FROM (
          SELECT worker_id FROM worker_job_applications WHERE job_posting_id = jp.id AND worker_id IS NOT NULL
          UNION
          SELECT worker_id FROM encuadres WHERE job_posting_id = jp.id AND worker_id IS NOT NULL
        ) _all) AS total_interested,
        (SELECT COUNT(DISTINCT worker_id) FROM worker_job_applications WHERE job_posting_id = jp.id) AS total_pre_screened,
        (SELECT COUNT(DISTINCT worker_id) FROM encuadres WHERE job_posting_id = jp.id) AS total_interviewed,
        (SELECT COUNT(DISTINCT worker_id) FROM encuadres WHERE job_posting_id = jp.id AND resultado = 'SELECCIONADO') AS total_approved,
        (SELECT COUNT(DISTINCT worker_id) FROM encuadres WHERE job_posting_id = jp.id AND resultado = 'RECHAZADO') AS total_rejected,
        (SELECT COUNT(DISTINCT worker_id) FROM encuadres WHERE job_posting_id = jp.id AND resultado = 'AT_NO_ACEPTA') AS total_no_acepta,
        (SELECT COUNT(id) FROM encuadres WHERE job_posting_id = jp.id AND (resultado IS NULL OR resultado = 'PENDIENTE')) AS total_pending,
        (SELECT COUNT(DISTINCT w.id) FROM workers w
         WHERE w.merged_into_id IS NULL
           AND w.id IN (
             SELECT worker_id FROM worker_job_applications WHERE job_posting_id = jp.id AND worker_id IS NOT NULL
             UNION
             SELECT worker_id FROM encuadres WHERE job_posting_id = jp.id AND worker_id IS NOT NULL
           )
        ) AS total_incomplete_registration
      FROM job_postings jp
      LEFT JOIN patients p ON jp.patient_id = p.id
      WHERE jp.case_number IS NOT NULL AND jp.deleted_at IS NULL`;
  }

  async getJobPostingStats(jobPostingId: string): Promise<JobPostingStats | null> {
    const result = await this.pool.query(
      `${this.jobPostingStatsQuery} AND jp.id = $1`,
      [jobPostingId],
    );
    return result.rows[0] ? this.mapJobPostingStats(result.rows[0]) : null;
  }

  async getJobPostingStatsByCaseNumber(caseNumber: number): Promise<JobPostingStats | null> {
    const result = await this.pool.query(
      `${this.jobPostingStatsQuery} AND jp.case_number = $1`,
      [caseNumber],
    );
    return result.rows[0] ? this.mapJobPostingStats(result.rows[0]) : null;
  }

  async listJobPostingStats(options: {
    limit?: number;
    offset?: number;
    status?: string;
  } = {}): Promise<JobPostingStats[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (options.status) {
      conditions.push(`jp.status = $${idx++}`);
      values.push(options.status);
    }

    const extra = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    values.push(options.limit ?? 50);
    values.push(options.offset ?? 0);

    const result = await this.pool.query(
      `${this.jobPostingStatsQuery} ${extra}
       ORDER BY jp.case_number ASC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      values,
    );
    return result.rows.map(r => this.mapJobPostingStats(r));
  }

  // ── 3. Workers com cadastro incompleto para uma vaga ──────────────────────

  async getWorkersIncompleteForVacancy(jobPostingId: string): Promise<WorkerRegistrationStatus[]> {
    // first_name / last_name foram removidos da view (migration 023) — criptografados no banco.
    // Retornamos null para esses campos; descriptografia pontual deve ser feita pelo caller se necessário.
    const result = await this.pool.query(
      `SELECT DISTINCT
         wro.worker_id, wro.email, wro.phone,
         wro.worker_status,
         wro.documents_status
       FROM v_worker_registration_overview wro
       WHERE wro.documents_status NOT IN ('submitted', 'verified')
         AND ${workerNotDisabledSql('wro.worker_id')}
         AND wro.worker_id IN (
           SELECT worker_id FROM worker_job_applications WHERE job_posting_id = $1 AND worker_id IS NOT NULL
           UNION
           SELECT worker_id FROM encuadres            WHERE job_posting_id = $1 AND worker_id IS NOT NULL
         )
       ORDER BY wro.worker_id`,
      [jobPostingId],
    );

    const workers = await Promise.all(result.rows.map(async r => {
      const otherVacancies = await this.getWorkerOtherVacancies(r.worker_id, jobPostingId);
      return {
        workerId: r.worker_id,
        email: r.email,
        phone: r.phone,
        firstName: null,
        lastName: null,
        workerStatus: r.worker_status,
        registrationCompleted: false,
        currentStep: 0,
        documentsStatus: r.documents_status,
        otherVacancies,
      } as WorkerRegistrationStatus;
    }));

    return workers;
  }

  // ── 4. Engajamento de um worker em vagas ──────────────────────────────────

  async getWorkerVacancyEngagement(workerId: string): Promise<WorkerVacancyEngagement | null> {
    // first_name / last_name removidos da view (migration 023) — dados agora criptografados.
    const [workerRes, vacRes] = await Promise.all([
      this.pool.query(
        `SELECT worker_id, email
         FROM v_worker_registration_overview WHERE worker_id = $1`,
        [workerId],
      ),
      this.pool.query(
        `SELECT
           e.job_posting_id, jp.case_number, p.first_name AS patient_name, jp.status AS case_status,
           e.resultado, e.attended, e.interview_date
         FROM encuadres e
         JOIN job_postings jp ON e.job_posting_id = jp.id AND jp.deleted_at IS NULL
         LEFT JOIN patients p ON jp.patient_id = p.id
         WHERE e.worker_id = $1
         UNION
         SELECT
           wja.job_posting_id, jp.case_number, p.first_name AS patient_name, jp.status AS case_status,
           NULL AS resultado, NULL AS attended, NULL AS interview_date
         FROM worker_job_applications wja
         JOIN job_postings jp ON wja.job_posting_id = jp.id AND jp.deleted_at IS NULL
         LEFT JOIN patients p ON jp.patient_id = p.id
         WHERE wja.worker_id = $1
           AND wja.job_posting_id NOT IN (
             SELECT job_posting_id FROM encuadres WHERE worker_id = $1
           )
         ORDER BY interview_date DESC NULLS LAST`,
        [workerId],
      ),
    ]);

    if (!workerRes.rows[0]) return null;
    const w = workerRes.rows[0];

    return {
      workerId: w.worker_id,
      email: w.email,
      firstName: null,
      lastName: null,
      registrationCompleted: false,
      vacancies: vacRes.rows.map(r => ({
        jobPostingId: r.job_posting_id,
        caseNumber: r.case_number ? parseInt(r.case_number) : null,
        patientName: r.patient_name,
        caseStatus: r.case_status,
        resultado: r.resultado,
        attended: r.attended,
        interviewDate: r.interview_date ? new Date(r.interview_date) : null,
        registrationCompleted: false,
      })),
    };
  }

  // ── 5. Workers sem documentos ─────────────────────────────────────────────

  async getWorkersMissingDocuments(options: {
    funnelStage?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<WorkerMissingDocs[]> {
    const conditions = [
      `documents_status NOT IN ('submitted', 'verified')`,
      workerNotDisabledSql('worker_id'),
    ];
    const values: unknown[] = [];
    let idx = 1;

    if (options.funnelStage) {
      conditions.push(`worker_status = $${idx++}`);
      values.push(options.funnelStage);
    }

    values.push(options.limit ?? 50);
    values.push(options.offset ?? 0);

    // first_name / last_name removidos da view (migration 023) — dados agora criptografados.
    const result = await this.pool.query(
      `SELECT
         worker_id, email, phone,
         worker_status, documents_status,
         total_vacancies_interviewed, total_vacancies_approved
       FROM v_worker_registration_overview
       WHERE ${conditions.join(' AND ')}
       ORDER BY total_vacancies_approved DESC, total_vacancies_interviewed DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      values,
    );

    return result.rows.map(r => ({
      workerId: r.worker_id,
      email: r.email,
      phone: r.phone,
      firstName: null,
      lastName: null,
      workerStatus: r.worker_status,
      documentsStatus: r.documents_status,
      totalVacanciesInterviewed: parseInt(r.total_vacancies_interviewed),
      totalVacanciesApproved: parseInt(r.total_vacancies_approved),
    }));
  }

  // ── 6. Candidatos a deduplicação ──────────────────────────────────────────

  /**
   * Versão escalar: busca duplicatas envolvendo apenas os workers passados.
   * Usada pelo pipeline de importação para escopar a busca aos registros recém-inseridos.
   */
  async findDuplicateCandidatesForWorkers(workerIds: string[]): Promise<DuplicateCandidate[]> {
    if (workerIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM v_potential_duplicate_workers
       WHERE worker1_id = ANY($1::uuid[]) OR worker2_id = ANY($1::uuid[])
       ORDER BY match_reason, worker1_id`,
      [workerIds],
    );
    return this.mapDuplicateRows(result.rows);
  }

  async findDuplicateCandidates(limit = 50): Promise<DuplicateCandidate[]> {
    const result = await this.pool.query(
      'SELECT * FROM v_potential_duplicate_workers ORDER BY match_reason, worker1_id LIMIT $1',
      [limit],
    );
    return this.mapDuplicateRows(result.rows);
  }

  /**
   * Mapeia as linhas brutas da v_potential_duplicate_workers para DuplicateCandidate,
   * descriptografando os nomes (que estão nas colunas *_encrypted) via KMS.
   * Os nomes descriptografados são passados ao LLM de deduplicação para análise.
   */
  private async mapDuplicateRows(rows: Record<string, unknown>[]): Promise<DuplicateCandidate[]> {
    return Promise.all(rows.map(async r => ({
      worker1Id:        r.worker1_id as string,
      worker1Phone:     r.worker1_phone as string | null,
      worker1Email:     r.worker1_email as string,
      worker1FirstName: r.worker1_first_name
        ? await this.encryptionService.decrypt(r.worker1_first_name as string) || null
        : null,
      worker1LastName:  r.worker1_last_name
        ? await this.encryptionService.decrypt(r.worker1_last_name as string) || null
        : null,
      worker1Cuit:      r.worker1_cuit as string | null,
      worker1Sources:   (r.worker1_sources as string[]) ?? [],
      worker2Id:        r.worker2_id as string,
      worker2Phone:     r.worker2_phone as string | null,
      worker2Email:     r.worker2_email as string,
      worker2FirstName: r.worker2_first_name
        ? await this.encryptionService.decrypt(r.worker2_first_name as string) || null
        : null,
      worker2LastName:  r.worker2_last_name
        ? await this.encryptionService.decrypt(r.worker2_last_name as string) || null
        : null,
      worker2Cuit:      r.worker2_cuit as string | null,
      worker2Sources:   (r.worker2_sources as string[]) ?? [],
      matchReason:      r.match_reason as DuplicateCandidate['matchReason'],
    })));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getWorkerOtherVacancies(workerId: string, excludeJobPostingId: string) {
    const result = await this.pool.query(
      `SELECT e.job_posting_id, jp.case_number, p.first_name AS patient_name, e.resultado
       FROM encuadres e
       JOIN job_postings jp ON e.job_posting_id = jp.id AND jp.deleted_at IS NULL
       LEFT JOIN patients p ON jp.patient_id = p.id
       WHERE e.worker_id = $1 AND e.job_posting_id <> $2
       UNION
       SELECT wja.job_posting_id, jp.case_number, p.first_name AS patient_name, NULL AS resultado
       FROM worker_job_applications wja
       JOIN job_postings jp ON wja.job_posting_id = jp.id AND jp.deleted_at IS NULL
       LEFT JOIN patients p ON jp.patient_id = p.id
       WHERE wja.worker_id = $1
         AND wja.job_posting_id <> $2
         AND wja.job_posting_id NOT IN (
           SELECT job_posting_id FROM encuadres WHERE worker_id = $1
         )`,
      [workerId, excludeJobPostingId],
    );
    return result.rows.map(r => ({
      jobPostingId:          r.job_posting_id,
      caseNumber:            r.case_number ? parseInt(r.case_number) : null,
      patientName:           r.patient_name,
      resultado:             r.resultado,
      registrationCompleted: false,
    }));
  }

  private mapJobPostingStats(r: Record<string, unknown>): JobPostingStats {
    return {
      jobPostingId:               r.job_posting_id as string,
      caseNumber:                 parseInt(r.case_number as string),
      patientName:                r.patient_name as string | null,
      caseStatus:                 r.case_status as string,
      priority:                   r.priority as string | null,
      dependency:                 r.dependency as string | null,
      coordinatorName:            r.coordinator_name as string | null,
      isCovered:                  r.is_covered as boolean,
      totalInterested:            parseInt(r.total_interested as string),
      totalPreScreened:           parseInt(r.total_pre_screened as string),
      totalInterviewed:           parseInt(r.total_interviewed as string),
      totalApproved:              parseInt(r.total_approved as string),
      totalRejected:              parseInt(r.total_rejected as string),
      totalNoAcepta:              parseInt(r.total_no_acepta as string),
      totalPending:               parseInt(r.total_pending as string),
      totalIncompleteRegistration: parseInt(r.total_incomplete_registration as string),
    };
  }
}
