import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  buildListVacanciesQuery,
  mapVacancyListRow,
  VacancyListRow,
} from './vacancyListHelpers';
import { normalizeSchedule } from '../../infrastructure/scheduleNormalizer';

/**
 * VacanciesController
 *
 * Read-only endpoints for the AdminVacanciesPage.
 *
 * Write endpoints (create/update/delete) → VacancyCrudController
 * Match/enrichment/encuadre endpoints   → VacancyMatchController
 * Talentum/prescreening endpoints        → VacancyTalentumController
 */

const inProgressQuerySchema = z.object({
  patient_id: z.string().uuid({ message: 'patient_id must be a valid UUID v4' }),
});

export class VacanciesController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async listVacancies(req: Request, res: Response): Promise<void> {
    try {
      const { search, status, priority, limit = '20', offset = '0' } = req.query;

      const { baseQuery, params, paramIndex } = buildListVacanciesQuery({
        search, status, priority, limit: limit as string, offset: offset as string,
      });

      const countQuery = `SELECT COUNT(*) as total FROM (${baseQuery}) as count_query`;
      const countResult = await this.db.query(countQuery, params);
      const total = parseInt(countResult.rows[0]?.total || '0');

      const finalQuery =
        baseQuery +
        ` ORDER BY jp.created_at DESC` +
        ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(parseInt(limit as string), parseInt(offset as string));

      const result = await this.db.query(finalQuery, params);
      const vacancies = (result.rows as VacancyListRow[]).map(mapVacancyListRow);

      res.status(200).json({
        success: true,
        data: vacancies,
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[VacanciesController] Error listing vacancies:', error);
      res.status(500).json({ success: false, error: 'Failed to list vacancies', details: msg });
    }
  }

  async getVacanciesStats(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE search_start_date IS NOT NULL
              AND EXTRACT(DAY FROM NOW() - search_start_date) > 7
              AND status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')
          ) as mais_7_dias,
          COUNT(*) FILTER (
            WHERE search_start_date IS NOT NULL
              AND EXTRACT(DAY FROM NOW() - search_start_date) > 24
              AND status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')
          ) as mais_24_dias,
          COUNT(DISTINCT jp.id) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM encuadres e WHERE e.job_posting_id = jp.id
            )
          ) as em_selecao,
          COUNT(*) FILTER (
            WHERE status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')
          ) as total_vacantes,
          AVG(
            CASE
              WHEN search_start_date IS NOT NULL
                AND status NOT IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')
              THEN EXTRACT(EPOCH FROM (updated_at - search_start_date)) / 3600
              ELSE NULL
            END
          ) as tempo_medio_fechamento
        FROM job_postings jp
        WHERE case_number IS NOT NULL AND deleted_at IS NULL
      `);

      const stats = result.rows[0];
      const formattedStats = [
        { label: '+7 dias',     value: stats.mais_7_dias?.toString() || '0',  icon: 'clock' as const },
        { label: '+24 dias',    value: stats.mais_24_dias?.toString() || '0', icon: 'clock' as const },
        { label: 'Em seleção',  value: stats.em_selecao?.toString() || '0',   icon: 'user-check' as const },
        {
          label: 'Total de Vacantes',
          value: stats.tempo_medio_fechamento
            ? `${Math.round(parseFloat(stats.tempo_medio_fechamento))}h`
            : '0h',
          icon: 'user-search' as const,
        },
      ];

      res.status(200).json({ success: true, data: formattedStats });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[VacanciesController] Error fetching stats:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch vacancies stats', details: msg });
    }
  }

  async getVacancyById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await this.db.query(`
        SELECT
          jp.*,
          jp.closes_at as closed_at,
          p.first_name as patient_first_name,
          p.last_name as patient_last_name,
          COALESCE(pa.neighborhood, p.zone_neighborhood) as patient_zone,
          p.dependency_level as dependency_level,
          p.diagnosis as patient_diagnosis,
          p.insurance_verified,
          p.service_type as service_type,
          COALESCE(pa.city, p.city_locality) as patient_city,
          COALESCE(pa.neighborhood, p.zone_neighborhood) as patient_neighborhood,
          pa.address_formatted as patient_address_formatted,
          pa.address_raw as patient_address_raw,
          json_agg(
            DISTINCT jsonb_build_object(
              'id', e.id,
              'worker_name', e.worker_raw_name,
              'worker_phone', COALESCE(w.phone, e.worker_raw_phone),
              'interview_date', e.interview_date,
              'resultado', e.resultado,
              'attended', e.attended,
              'rejection_reason_category', e.rejection_reason_category,
              'rejection_reason', e.rejection_reason
            )
          ) FILTER (WHERE e.id IS NOT NULL) as encuadres,
          json_agg(
            DISTINCT jsonb_build_object(
              'channel', pub.channel,
              'published_at', pub.published_at,
              'recruiter', pub.recruiter_name
            )
          ) FILTER (WHERE pub.id IS NOT NULL) as publications
        FROM job_postings jp
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
        LEFT JOIN encuadres e ON jp.id = e.job_posting_id
        LEFT JOIN workers w ON e.worker_id = w.id
        LEFT JOIN publications pub ON jp.id = pub.job_posting_id
        WHERE jp.id = $1
        GROUP BY jp.id, p.id, pa.id
      `, [id]);

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const row = result.rows[0];
      const normalized = {
        ...row,
        schedule: normalizeSchedule(row.schedule),
      };
      res.status(200).json({ success: true, data: normalized });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[VacanciesController] Error fetching vacancy:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch vacancy', details: msg });
    }
  }

  async getNextVacancyNumber(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(
        `SELECT nextval('job_postings_vacancy_number_seq') AS next_vacancy_number`,
      );
      const nextVacancyNumber = parseInt(result.rows[0].next_vacancy_number);
      res.status(200).json({ success: true, data: { nextVacancyNumber } });
    } catch (error: unknown) {
      console.error('[VacanciesController] Error getting next vacancy number:', error);
      res.status(500).json({ success: false, error: 'Failed to get next vacancy number' });
    }
  }

  async getCasesForSelect(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(`
        SELECT
          p.case_number   AS "caseNumber",
          p.id            AS "patientId",
          COALESCE(p.dependency_level, '') AS "dependencyLevel"
        FROM patients p
        WHERE p.case_number IS NOT NULL
          AND p.deleted_at IS NULL
          AND p.status IN ('ACTIVE', 'PENDING_ADMISSION', 'ADMISSION')
          AND EXISTS (
            SELECT 1 FROM patient_addresses pa WHERE pa.patient_id = p.id
          )
        ORDER BY p.case_number DESC
      `);
      res.status(200).json({ success: true, data: result.rows });
    } catch (error: unknown) {
      console.error('[VacanciesController] Error fetching cases for select:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch cases for select' });
    }
  }

  async listPendingAddressReview(req: Request, res: Response): Promise<void> {
    try {
      const { status } = req.query;
      const params: unknown[] = [];

      let query = `
        SELECT
          jp.id, jp.case_number, jp.vacancy_number, jp.title, jp.status,
          audit.attempted_match AS legacy_address_hint,
          p.id AS patient_id,
          TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')) AS patient_name,
          audit.match_type AS audit_match_type,
          audit.confidence_score AS audit_confidence_score,
          audit.attempted_match AS audit_attempted_match
        FROM job_postings jp
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN LATERAL (
          SELECT match_type, confidence_score, attempted_match
          FROM _patient_address_match_audit
          WHERE job_posting_id = jp.id
          ORDER BY created_at DESC LIMIT 1
        ) audit ON TRUE
        WHERE jp.patient_address_id IS NULL AND jp.deleted_at IS NULL
      `;

      if (status) {
        params.push(status);
        query += ` AND jp.status = $${params.length}`;
      }
      query += ` ORDER BY jp.case_number ASC`;

      const result = await this.db.query(query, params);
      res.status(200).json({ success: true, data: result.rows, total: result.rows.length });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[VacanciesController] listPendingAddressReview error:', error);
      res.status(500).json({ success: false, error: 'Failed to list pending address reviews', details: msg });
    }
  }

  /**
   * GET /api/admin/vacancies/in-progress?patient_id=:uuid
   *
   * Returns draft vacancies (is_draft = true) created via the app
   * (not ClickUp-synced) for the given patient. Used by the frontend to prompt
   * resuming interrupted creation. The is_draft flag (migration 168) decouples
   * "draft" from status, so vacancies whose status the operator already picked
   * (SEARCHING, SEARCHING_REPLACEMENT, RAPID_RESPONSE) still show up here while
   * they have not been published to Talentum.
   */
  async listInProgressForPatient(req: Request, res: Response): Promise<void> {
    const parsed = inProgressQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      res.status(400).json({
        success: false,
        error: firstIssue?.message ?? 'patient_id must be a valid UUID v4',
      });
      return;
    }

    const { patient_id } = parsed.data;

    try {
      const result = await this.db.query(
        `SELECT
          jp.id,
          jp.case_number,
          jp.vacancy_number,
          jp.title,
          jp.created_at,
          jp.updated_at
        FROM job_postings jp
        LEFT JOIN job_postings_clickup_sync sync ON sync.job_posting_id = jp.id
        WHERE jp.patient_id = $1
          AND jp.is_draft = true
          AND jp.deleted_at IS NULL
          AND sync.job_posting_id IS NULL
        ORDER BY jp.updated_at DESC`,
        [patient_id],
      );

      res.status(200).json({ success: true, data: result.rows });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[VacanciesController] listInProgressForPatient error:', error);
      res.status(500).json({ success: false, error: 'Failed to list in-progress vacancies', details: msg });
    }
  }
}
