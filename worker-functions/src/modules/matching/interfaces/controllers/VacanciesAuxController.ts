/**
 * VacanciesAuxController
 *
 * Auxiliary read endpoints extracted from VacanciesController to stay within
 * the 400-line file limit:
 *   - listPendingAddressReview
 *   - listInProgressForPatient
 *   - listByAddress
 *   - getFilterOptions  (GET /api/admin/vacancies/filter-options)
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';

const inProgressQuerySchema = z.object({
  patient_id: z.string().uuid({ message: 'patient_id must be a valid UUID v4' }),
});

const byAddressQuerySchema = z.object({
  patient_address_id: z.string().uuid({ message: 'patient_address_id must be a valid UUID v4' }),
});

export class VacanciesAuxController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
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
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesAuxController:listPendingAddressReview' },
      );
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
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesAuxController:listInProgressForPatient' },
      );
      res.status(500).json({ success: false, error: 'Failed to list in-progress vacancies', details: msg });
    }
  }

  /**
   * GET /api/admin/vacancies/by-address?patient_address_id=:uuid
   *
   * Returns existing vacancies that already point to the given patient_address_id
   * (not soft-deleted). Used by the frontend Step-1 form to warn the operator
   * when there is already a vacancy targeting the chosen address.
   * Documented in: docs/features/vacancy-creation/05-fluxo-criacao.md
   */
  async listByAddress(req: Request, res: Response): Promise<void> {
    const parsed = byAddressQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      res.status(400).json({
        success: false,
        error: firstIssue?.message ?? 'patient_address_id must be a valid UUID v4',
      });
      return;
    }

    const { patient_address_id } = parsed.data;

    try {
      const result = await this.db.query(
        `SELECT
          jp.id,
          jp.case_number,
          jp.vacancy_number,
          jp.title,
          jp.status,
          jp.is_draft,
          jp.talentum_published_at,
          jp.created_at
        FROM job_postings jp
        WHERE jp.patient_address_id = $1
          AND jp.deleted_at IS NULL
          AND jp.status <> 'CLOSED'
        ORDER BY jp.created_at DESC`,
        [patient_address_id],
      );

      res.status(200).json({ success: true, data: result.rows });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesAuxController:listByAddress' },
      );
      res.status(500).json({ success: false, error: 'Failed to list vacancies by address', details: msg });
    }
  }

  /**
   * GET /api/admin/vacancies/filter-options
   *
   * Returns distinct non-empty state and city values from patient_addresses
   * for listable vacancies (case_number not null, deleted_at null).
   * Used by the frontend filter panel to populate the state/city dropdowns.
   */
  async getFilterOptions(req: Request, res: Response): Promise<void> {
    try {
      const [statesResult, citiesResult] = await Promise.all([
        this.db.query<{ state: string }>(`
          SELECT DISTINCT pa.state
          FROM job_postings jp
          JOIN patient_addresses pa ON jp.patient_address_id = pa.id
          WHERE jp.case_number IS NOT NULL
            AND jp.deleted_at IS NULL
            AND pa.state IS NOT NULL
            AND btrim(pa.state) <> ''
          ORDER BY pa.state
        `),
        this.db.query<{ city: string }>(`
          SELECT DISTINCT pa.city
          FROM job_postings jp
          JOIN patient_addresses pa ON jp.patient_address_id = pa.id
          WHERE jp.case_number IS NOT NULL
            AND jp.deleted_at IS NULL
            AND pa.city IS NOT NULL
            AND btrim(pa.city) <> ''
          ORDER BY pa.city
        `),
      ]);

      res.status(200).json({
        success: true,
        data: {
          states: statesResult.rows.map(r => r.state),
          cities: citiesResult.rows.map(r => r.city),
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesAuxController:getFilterOptions' },
      );
      res.status(500).json({ success: false, error: 'Failed to fetch filter options', details: msg });
    }
  }
}
