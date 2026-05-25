import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

/**
 * EncuadreDashboardController
 *
 * Coordinator dashboard endpoints — extracted from EncuadreFunnelController
 * to keep each file under 400 lines.
 *
 * - GET /api/admin/dashboard/coordinator-capacity
 * - GET /api/admin/dashboard/alerts
 * - GET /api/admin/dashboard/conversion-by-channel
 */
export class EncuadreDashboardController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  /**
   * GET /api/admin/dashboard/coordinator-capacity
   *
   * Returns per-coordinator capacity metrics.
   */
  async getCoordinatorCapacity(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(`
        SELECT
          c.id,
          c.name,
          -- Latest weekly hours from coordinator_weekly_schedules
          (
            SELECT cws.weekly_hours
            FROM coordinator_weekly_schedules cws
            WHERE cws.coordinator_id = c.id
            ORDER BY cws.to_date DESC
            LIMIT 1
          ) AS weekly_hours,
          -- Active cases (not covered)
          (
            SELECT COUNT(*)::int
            FROM job_postings jp
            WHERE jp.coordinator_id = c.id
              AND jp.is_covered = false
              AND jp.deleted_at IS NULL
          ) AS active_cases,
          -- Encuadres this week
          (
            SELECT COUNT(*)::int
            FROM encuadres e
            JOIN job_postings jp ON jp.id = e.job_posting_id
            WHERE jp.coordinator_id = c.id
              AND e.interview_date >= date_trunc('week', CURRENT_DATE)
              AND e.interview_date < date_trunc('week', CURRENT_DATE) + interval '7 days'
          ) AS encuadres_this_week,
          -- Conversion rate: SELECCIONADO / total attended
          (
            SELECT COUNT(*) FILTER (WHERE e.resultado = 'SELECCIONADO')::float
              / NULLIF(COUNT(*) FILTER (WHERE e.attended = true), 0)
            FROM encuadres e
            JOIN job_postings jp ON jp.id = e.job_posting_id
            WHERE jp.coordinator_id = c.id
          ) AS conversion_rate,
          -- Total cases managed
          (
            SELECT COUNT(*)::int
            FROM job_postings jp
            WHERE jp.coordinator_id = c.id
              AND jp.deleted_at IS NULL
          ) AS total_cases
        FROM coordinators c
        ORDER BY c.name
      `);

      res.json({
        success: true,
        data: result.rows.map(row => ({
          id: row.id,
          name: row.name,
          weeklyHours: row.weekly_hours ? parseFloat(row.weekly_hours) : null,
          activeCases: row.active_cases,
          encuadresThisWeek: row.encuadres_this_week,
          conversionRate: row.conversion_rate ? parseFloat(row.conversion_rate) : null,
          totalCases: row.total_cases,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[EncuadreDashboardController] capacity error:', message);
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * GET /api/admin/dashboard/alerts
   *
   * Returns problem cases that need human intervention.
   */
  async getAlerts(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(`
        SELECT
          jp.id,
          jp.case_number,
          jp.vacancy_number,
          jp.title,
          jp.coordinator_name,
          jp.search_start_date,
          jp.is_covered,
          EXTRACT(DAY FROM NOW() - jp.search_start_date)::int AS days_open,
          (SELECT COUNT(*)::int FROM encuadres e WHERE e.job_posting_id = jp.id) AS total_encuadres,
          (SELECT COUNT(*)::int FROM encuadres e
           WHERE e.job_posting_id = jp.id AND e.resultado = 'SELECCIONADO') AS selected_count,
          (SELECT COUNT(*)::int FROM encuadres e
           WHERE e.job_posting_id = jp.id
             AND e.created_at >= NOW() - interval '7 days') AS recent_encuadres
        FROM job_postings jp
        WHERE jp.deleted_at IS NULL
          AND jp.is_covered = false
          AND (
            -- Cases with >200 encuadres without success
            (SELECT COUNT(*) FROM encuadres e
             WHERE e.job_posting_id = jp.id) > 200
            AND (SELECT COUNT(*) FROM encuadres e
                 WHERE e.job_posting_id = jp.id AND e.resultado = 'SELECCIONADO') = 0
            -- OR cases open >30 days without coverage
            OR (jp.search_start_date IS NOT NULL
                AND jp.search_start_date < NOW() - interval '30 days')
            -- OR cases with 0 candidates in last 7 days
            OR (SELECT COUNT(*) FROM encuadres e
                WHERE e.job_posting_id = jp.id
                  AND e.created_at >= NOW() - interval '7 days') = 0
          )
        ORDER BY
          CASE
            WHEN (SELECT COUNT(*) FROM encuadres e WHERE e.job_posting_id = jp.id) > 200 THEN 1
            WHEN jp.search_start_date < NOW() - interval '30 days' THEN 2
            ELSE 3
          END,
          jp.search_start_date ASC NULLS LAST
      `);

      const alerts = result.rows.map(row => {
        const reasons: string[] = [];
        if (row.total_encuadres > 200 && row.selected_count === 0) {
          reasons.push('MORE_THAN_200_ENCUADRES');
        }
        if (row.days_open > 30) {
          reasons.push('OPEN_MORE_THAN_30_DAYS');
        }
        if (row.recent_encuadres === 0) {
          reasons.push('NO_CANDIDATES_LAST_7_DAYS');
        }

        return {
          jobPostingId: row.id,
          caseNumber: row.case_number,
          vacancyNumber: row.vacancy_number,
          title: row.title,
          coordinatorName: row.coordinator_name,
          daysOpen: row.days_open,
          totalEncuadres: row.total_encuadres,
          selectedCount: row.selected_count,
          recentEncuadres: row.recent_encuadres,
          alertReasons: reasons,
        };
      });

      res.json({ success: true, data: alerts });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[EncuadreDashboardController] alerts error:', message);
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * GET /api/admin/dashboard/conversion-by-channel
   *
   * Returns conversion rates (SELECCIONADO / total) grouped by recruitment origin channel.
   */
  async getConversionByChannel(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(`
        SELECT
          COALESCE(e.import_source_audit, 'Desconocido') AS channel,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE e.resultado = 'SELECCIONADO')::int AS selected,
          COUNT(*) FILTER (WHERE e.attended = true)::int AS attended,
          ROUND(
            COUNT(*) FILTER (WHERE e.resultado = 'SELECCIONADO')::numeric
            / NULLIF(COUNT(*) FILTER (WHERE e.attended = true), 0),
            3
          ) AS conversion_rate
        FROM encuadres e
        WHERE e.job_posting_id IS NOT NULL
        GROUP BY COALESCE(e.import_source_audit, 'Desconocido')
        ORDER BY total DESC
      `);

      res.json({
        success: true,
        data: result.rows.map(row => ({
          channel: row.channel,
          total: row.total,
          selected: row.selected,
          attended: row.attended,
          conversionRate: row.conversion_rate ? parseFloat(row.conversion_rate) : null,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[EncuadreDashboardController] conversion-by-channel error:', message);
      res.status(500).json({ success: false, error: message });
    }
  }
}
