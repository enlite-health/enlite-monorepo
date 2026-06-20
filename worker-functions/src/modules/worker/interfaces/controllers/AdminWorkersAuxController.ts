/**
 * AdminWorkersAuxController.ts
 *
 * Auxiliary endpoints extracted from AdminWorkersController to keep each file
 * within the 400-line limit.
 *
 * Endpoints:
 * - GET  /api/admin/workers/stats          — worker registration date stats
 * - GET  /api/admin/workers/case-options   — job_postings for select inputs
 * - GET  /api/admin/workers/filter-options — distinct states, cities, experience & preferred types
 * - POST /api/admin/workers/sync-talentum  — bulk sync from Talentum dashboard
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { SyncTalentumWorkersUseCase } from '@modules/integration';
import { reportError } from '@shared/logging';

interface WorkerDateStats {
  today: number;
  yesterday: number;
  sevenDaysAgo: number;
}

export class AdminWorkersAuxController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  /**
   * GET /api/admin/workers/stats
   * Retorna contagem de workers cadastrados hoje, ontem e nos últimos 7 dias.
   */
  async getWorkerDateStats(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query<{ today: string; yesterday: string; seven_days_ago: string }>(`
        SELECT
          COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date)::int       AS today,
          COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 1)::int   AS yesterday,
          COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 7)::int  AS seven_days_ago
        FROM workers WHERE merged_into_id IS NULL
      `);
      const row = result.rows[0];
      const stats: WorkerDateStats = {
        today: parseInt(row.today, 10),
        yesterday: parseInt(row.yesterday, 10),
        sevenDaysAgo: parseInt(row.seven_days_ago, 10),
      };
      res.status(200).json({ success: true, data: stats });
    } catch (error: any) {
      console.error('[AdminWorkersAuxController] getWorkerDateStats error:', error);
      res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas de workers', details: error.message });
    }
  }

  /**
   * GET /api/admin/workers/case-options
   * Retorna id + label de todos os job_postings ativos para popular selects de filtro.
   */
  async listCaseOptions(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(`
        SELECT jp.id, jp.case_number, jp.vacancy_number, jp.title,
               p.first_name AS patient_first_name, p.last_name AS patient_last_name
        FROM job_postings jp
        LEFT JOIN patients p ON jp.patient_id = p.id
        WHERE jp.deleted_at IS NULL AND jp.status != 'CLOSED'
        ORDER BY jp.case_number DESC NULLS LAST, jp.vacancy_number DESC
      `);

      const data = result.rows.map((row: any) => {
        const patientName = [row.patient_first_name, row.patient_last_name].filter(Boolean).join(' ');
        const label = patientName
          ? `${row.title} — ${patientName}`
          : row.title;
        return { value: row.id, label };
      });

      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AdminWorkersAuxController] listCaseOptions error:', error);
      res.status(500).json({ success: false, error: 'Failed to list case options', details: error.message });
    }
  }

  /**
   * GET /api/admin/workers/filter-options
   *
   * Returns distinct non-empty values for dynamic filter dropdowns:
   *   - states: distinct worker_service_areas.state values (sorted)
   *   - cities: distinct worker_service_areas.city values (sorted)
   *   - experienceTypes: distinct unnested experience_types values (sorted)
   *   - preferredTypes: distinct unnested preferred_types values (sorted)
   *
   * NOT included (fixed enums the frontend already knows):
   *   profession, sex, languages, preferred_age_range, days
   */
  async getFilterOptions(_req: Request, res: Response): Promise<void> {
    try {
      const [statesResult, citiesResult, expTypesResult, prefTypesResult] = await Promise.all([
        this.db.query<{ state: string }>(`
          SELECT DISTINCT wsa.state
          FROM worker_service_areas wsa
          JOIN workers w ON wsa.worker_id = w.id
          WHERE w.merged_into_id IS NULL
            AND wsa.state IS NOT NULL
            AND btrim(wsa.state) <> ''
          ORDER BY wsa.state
        `),
        this.db.query<{ city: string }>(`
          SELECT DISTINCT wsa.city
          FROM worker_service_areas wsa
          JOIN workers w ON wsa.worker_id = w.id
          WHERE w.merged_into_id IS NULL
            AND wsa.city IS NOT NULL
            AND btrim(wsa.city) <> ''
          ORDER BY wsa.city
        `),
        this.db.query<{ val: string }>(`
          SELECT DISTINCT unnest(experience_types) AS val
          FROM workers
          WHERE merged_into_id IS NULL
            AND experience_types IS NOT NULL
          ORDER BY val
        `),
        this.db.query<{ val: string }>(`
          SELECT DISTINCT unnest(preferred_types) AS val
          FROM workers
          WHERE merged_into_id IS NULL
            AND preferred_types IS NOT NULL
          ORDER BY val
        `),
      ]);

      res.status(200).json({
        success: true,
        data: {
          states: statesResult.rows.map((r) => r.state),
          cities: citiesResult.rows.map((r) => r.city),
          experienceTypes: expTypesResult.rows.map((r) => r.val),
          preferredTypes: prefTypesResult.rows.map((r) => r.val),
        },
      });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'AdminWorkersAuxController:getFilterOptions' });
      res.status(500).json({ success: false, error: 'Failed to fetch filter options', details: e.message });
    }
  }

  /** POST /api/admin/workers/sync-talentum — bulk sync workers from Talentum dashboard */
  async syncTalentumWorkers(_req: Request, res: Response): Promise<void> {
    // In test environments there are no GCP credentials (ADC), so google-auth-library
    // would make async background retries that trigger uncaughtException and kill the
    // process. Return 503 early to avoid touching GoogleAuth entirely.
    if (process.env.NODE_ENV === 'test') {
      res.status(503).json({ success: false, error: 'Talentum sync disabled in test environment' });
      return;
    }

    try {
      const useCase = new SyncTalentumWorkersUseCase();
      const report = await useCase.execute();
      res.status(200).json({ success: true, data: report });
    } catch (error: any) {
      const isTalentumError = error.message?.includes('Talentum') || error.message?.includes('tl_auth');
      const status = isTalentumError ? 502 : 500;
      console.error('[AdminWorkersAuxController] syncTalentumWorkers error:', error);
      res.status(status).json({ success: false, error: 'Failed to sync workers from Talentum', details: error.message });
    }
  }
}
