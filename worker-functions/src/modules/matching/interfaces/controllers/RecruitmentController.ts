import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  parsePaginationOptions,
  buildPaginationClause,
  createPaginatedResponse,
} from '@shared/utils/pagination';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';

/**
 * RecruitmentController
 *
 * Endpoints de listagem do dashboard de recrutamento:
 * - GET /api/admin/recruitment/clickup-cases
 * - GET /api/admin/recruitment/talentum-workers
 * - GET /api/admin/recruitment/progreso
 * - GET /api/admin/recruitment/publications
 * - GET /api/admin/recruitment/encuadres
 *
 * Endpoints analíticos → RecruitmentAnalyticsController
 */
export class RecruitmentController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  /**
   * GET /api/admin/recruitment/clickup-cases
   */
  async getClickUpCases(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate, status } = req.query;
      const paginationOptions = parsePaginationOptions(req.query);

      let baseQuery = `
        SELECT
          jp.id,
          jp.case_number,
          jp.vacancy_number,
          cs.clickup_task_id,
          jp.title,
          jp.status,
          jp.priority,
          p.diagnosis as diagnosis,
          p.zone_neighborhood as patient_zone,
          p.city_locality as patient_neighborhood,
          jp.worker_profile_sought,
          jp.schedule_days_hours,
          cs.source_created_at,
          cs.source_updated_at,
          jp.due_date,
          jp.search_start_date,
          cs.last_clickup_comment as last_comment,
          p.dependency_level as dependency,
          p.first_name as patient_name,
          c.name AS coordinator_name,
          jp.is_covered,
          jp.weekly_hours,
          jp.providers_needed,
          jp.active_providers,
          jp.authorized_period,
          jp.marketing_channel,
          jp.assignee,
          jp.daily_obs,
          jp.inferred_zone,
          p.first_name as patient_first_name,
          p.last_name as patient_last_name,
          p.dependency_level,
          p.clinical_segments,
          p.service_type,
          p.zone_neighborhood as patient_zone_detail
        FROM job_postings jp
        LEFT JOIN job_postings_clickup_sync cs ON cs.job_posting_id = jp.id
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN coordinators c ON c.id = jp.coordinator_id
        WHERE jp.case_number IS NOT NULL
          AND jp.deleted_at IS NULL
      `;

      const params: any[] = [];
      let paramIndex = 1;

      if (status) {
        baseQuery += ` AND jp.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (startDate) {
        baseQuery += ` AND jp.search_start_date >= $${paramIndex}`;
        params.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        baseQuery += ` AND jp.search_start_date <= $${paramIndex}`;
        params.push(endDate);
        paramIndex++;
      }

      const paginationClause = buildPaginationClause(paginationOptions);
      const queryWithPagination = baseQuery + ` ORDER BY jp.case_number DESC ${paginationClause}`;

      const [dataResult, countResult] = await Promise.all([
        this.db.query(queryWithPagination, params),
        this.db.query(`SELECT COUNT(*) as total FROM (${baseQuery.replace(/GROUP BY.*$/, 'LIMIT 1')}) as subq`, params),
      ]);

      const total = parseInt(countResult.rows[0]?.total || '0');
      const response = createPaginatedResponse(dataResult.rows, paginationOptions, total);

      res.status(200).json(response);
    } catch (error: any) {
      console.error('[RecruitmentController] Error fetching ClickUp cases:', error);
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('page') || msg.includes('limit')) {
        res.status(400).json({ success: false, error: error.message });
      } else {
        res.status(500).json({ success: false, error: 'Failed to fetch ClickUp cases' });
      }
    }
  }

  /**
   * GET /api/admin/recruitment/talentum-workers
   */
  async getTalentumWorkers(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = req.query;
      const paginationOptions = parsePaginationOptions(req.query);

      let baseQuery = `
        SELECT
          w.id, w.email, w.phone, w.status, w.created_at, w.updated_at,
          COALESCE(
            json_agg(
              DISTINCT jsonb_build_object(
                'case_number', jp.case_number,
                'interview_date', e.interview_date,
                'resultado', e.resultado
              )
            ) FILTER (WHERE e.id IS NOT NULL),
            '[]'
          ) as pre_screenings
        FROM workers w
        LEFT JOIN encuadres e ON w.id = e.worker_id
        LEFT JOIN job_postings jp ON e.job_posting_id = jp.id
        WHERE w.status = 'REGISTERED'
      `;

      const params: any[] = [];
      let paramIndex = 1;

      if (startDate) { baseQuery += ` AND w.created_at >= $${paramIndex}`; params.push(startDate); paramIndex++; }
      if (endDate)   { baseQuery += ` AND w.created_at <= $${paramIndex}`; params.push(endDate);   paramIndex++; }

      baseQuery += ` GROUP BY w.id`;

      const paginationClause = buildPaginationClause(paginationOptions);
      const queryWithPagination = baseQuery + ` ORDER BY w.created_at DESC ${paginationClause}`;

      const [dataResult, countResult] = await Promise.all([
        this.db.query(queryWithPagination, params),
        this.db.query(`SELECT COUNT(DISTINCT w.id) as total FROM workers w WHERE w.status = 'REGISTERED'`, params),
      ]);

      const total = parseInt(countResult.rows[0]?.total || '0');
      res.status(200).json(createPaginatedResponse(dataResult.rows, paginationOptions, total));
    } catch (error: any) {
      console.error('[RecruitmentController] Error fetching Talentum workers:', error);
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('page') || msg.includes('limit')) {
        res.status(400).json({ success: false, error: 'Invalid pagination parameters', details: error.message });
      } else {
        res.status(500).json({ success: false, error: 'Failed to fetch Talentum workers', details: error.message });
      }
    }
  }

  /**
   * GET /api/admin/recruitment/progreso
   */
  async getProgresoWorkers(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = req.query;
      const paginationOptions = parsePaginationOptions(req.query);

      let baseQuery = `
        SELECT w.id, w.email, w.phone, w.status, w.created_at, w.updated_at
        FROM workers w
        WHERE w.status = 'REGISTERED'
      `;

      const params: any[] = [];
      let paramIndex = 1;

      if (startDate) { baseQuery += ` AND w.created_at >= $${paramIndex}`; params.push(startDate); paramIndex++; }
      if (endDate)   { baseQuery += ` AND w.created_at <= $${paramIndex}`; params.push(endDate);   paramIndex++; }

      const paginationClause = buildPaginationClause(paginationOptions);
      const queryWithPagination = baseQuery + ` ORDER BY w.created_at DESC ${paginationClause}`;

      const [dataResult, countResult] = await Promise.all([
        this.db.query(queryWithPagination, params),
        this.db.query(`SELECT COUNT(*) as total FROM (${baseQuery.replace(/GROUP BY.*$/, 'LIMIT 1')}) as subq`, params),
      ]);

      const total = parseInt(countResult.rows[0]?.total || '0');
      res.status(200).json(createPaginatedResponse(dataResult.rows, paginationOptions, total));
    } catch (error: any) {
      console.error('[RecruitmentController] Error fetching progreso workers:', error);
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('page') || msg.includes('limit')) {
        res.status(400).json({ success: false, error: 'Invalid pagination parameters', details: error.message });
      } else {
        res.status(500).json({ success: false, error: 'Failed to fetch progreso workers', details: error.message });
      }
    }
  }

  /**
   * GET /api/admin/recruitment/publications
   */
  async getPublications(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate, caseNumber } = req.query;
      const paginationOptions = parsePaginationOptions(req.query);

      let baseQuery = `
        SELECT
          p.id, p.channel, p.group_name, p.group_geographic_zone,
          p.recruiter_name, p.published_at, p.observations, p.created_at,
          jp.case_number, jp.title,
          pt.zone_neighborhood as patient_zone
        FROM publications p
        LEFT JOIN job_postings jp ON p.job_posting_id = jp.id AND jp.deleted_at IS NULL
        LEFT JOIN patients pt ON jp.patient_id = pt.id
        WHERE 1=1
      `;

      const params: any[] = [];
      let paramIndex = 1;

      if (caseNumber) { baseQuery += ` AND jp.case_number = $${paramIndex}`; params.push(parseInt(caseNumber as string)); paramIndex++; }
      if (startDate)  { baseQuery += ` AND p.published_at >= $${paramIndex}`; params.push(startDate); paramIndex++; }
      if (endDate)    { baseQuery += ` AND p.published_at <= $${paramIndex}`; params.push(endDate);   paramIndex++; }

      const paginationClause = buildPaginationClause(paginationOptions);
      const queryWithPagination = baseQuery + ` ORDER BY p.published_at DESC ${paginationClause}`;

      const [dataResult, countResult] = await Promise.all([
        this.db.query(queryWithPagination, params),
        this.db.query(
          `SELECT COUNT(*) as total FROM publications p LEFT JOIN job_postings jp ON p.job_posting_id = jp.id AND jp.deleted_at IS NULL LEFT JOIN patients pt ON jp.patient_id = pt.id WHERE 1=1`,
          params,
        ),
      ]);

      const total = parseInt(countResult.rows[0]?.total || '0');
      res.status(200).json(createPaginatedResponse(dataResult.rows, paginationOptions, total));
    } catch (error: any) {
      console.error('[RecruitmentController] Error fetching publications:', error);
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('page') || msg.includes('limit')) {
        res.status(400).json({ success: false, error: 'Invalid pagination parameters', details: error.message });
      } else {
        res.status(500).json({ success: false, error: 'Failed to fetch publications', details: error.message });
      }
    }
  }

  /**
   * GET /api/admin/recruitment/encuadres
   */
  async getEncuadres(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate, caseNumber, resultado } = req.query;
      const paginationOptions = parsePaginationOptions(req.query);

      let baseQuery = `
        SELECT
          e.id, e.worker_id, e.job_posting_id,
          e.worker_raw_name, e.worker_raw_phone, e.occupation_raw,
          e.recruiter_name, c.name AS coordinator_name,
          e.recruitment_date, e.interview_date, e.interview_time, e.meet_link,
          e.attended, e.absence_reason, e.accepts_case, e.rejection_reason, e.resultado,
          e.redireccionamiento, e.has_cv, e.has_dni, e.has_cert_at, e.has_afip,
          e.has_cbu, e.has_ap, e.has_seguros,
          e.obs_reclutamiento, e.obs_encuadre, e.obs_adicionales,
          e.created_at, e.updated_at,
          jp.case_number, jp.title,
          p.zone_neighborhood as patient_zone,
          w.email as worker_email, w.phone as worker_phone
        FROM encuadres e
        LEFT JOIN job_postings jp ON e.job_posting_id = jp.id AND jp.deleted_at IS NULL
        LEFT JOIN workers w ON e.worker_id = w.id
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN coordinators c ON c.id = e.coordinator_id
        WHERE 1=1
          -- worker que deu baixa na conta não é candidato contatável (mesmo recorte
          -- de FunnelTableRepository/VacancyMatchController/WJAFunnelController)
          AND ${excludeDisabledWorkersSql('w')}
      `;

      const params: any[] = [];
      let paramIndex = 1;

      if (caseNumber) { baseQuery += ` AND jp.case_number = $${paramIndex}`; params.push(parseInt(caseNumber as string)); paramIndex++; }
      if (resultado)  { baseQuery += ` AND e.resultado = $${paramIndex}`;   params.push(resultado); paramIndex++; }
      if (startDate)  { baseQuery += ` AND e.interview_date >= $${paramIndex}`; params.push(startDate); paramIndex++; }
      if (endDate)    { baseQuery += ` AND e.interview_date <= $${paramIndex}`; params.push(endDate);   paramIndex++; }

      const paginationClause = buildPaginationClause(paginationOptions);
      const queryWithPagination = baseQuery + ` ORDER BY e.interview_date DESC NULLS LAST ${paginationClause}`;

      const [dataResult, countResult] = await Promise.all([
        this.db.query(queryWithPagination, params),
        this.db.query(`SELECT COUNT(*) as total FROM (${baseQuery.replace(/GROUP BY.*$/, 'LIMIT 1')}) as subq`, params),
      ]);

      const total = parseInt(countResult.rows[0]?.total || '0');
      res.status(200).json(createPaginatedResponse(dataResult.rows, paginationOptions, total));
    } catch (error: any) {
      console.error('[RecruitmentController] Error fetching encuadres:', error);
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('page') || msg.includes('limit')) {
        res.status(400).json({ success: false, error: 'Invalid pagination parameters', details: error.message });
      } else {
        res.status(500).json({ success: false, error: 'Failed to fetch encuadres', details: error.message });
      }
    }
  }
}
