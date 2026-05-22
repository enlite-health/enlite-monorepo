import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

/**
 * RecruitmentAnalyticsController
 *
 * Endpoints analíticos do dashboard de recrutamento:
 * - GET /api/admin/recruitment/global-metrics
 * - GET /api/admin/recruitment/case/:caseNumber
 * - GET /api/admin/recruitment/zones
 * - POST /api/admin/recruitment/calculate-reemplazos
 *
 * Extraído de RecruitmentController para respeitar o limite de 400 linhas.
 */
export class RecruitmentAnalyticsController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  /**
   * GET /api/admin/recruitment/global-metrics
   */
  async getGlobalMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = req.query;

      const activeCasesQuery = `
        SELECT
          COUNT(*) FILTER (WHERE status IN ('SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE')) as active_cases_count,
          COUNT(*) FILTER (WHERE status = 'SEARCHING') as searching_count,
          COUNT(*) FILTER (WHERE status = 'SEARCHING_REPLACEMENT') as searching_replacement_count
        FROM job_postings
        WHERE case_number IS NOT NULL
          AND deleted_at IS NULL
      `;

      let talentumQuery = `SELECT COUNT(*) as talentum_count FROM workers WHERE status = 'REGISTERED'`;
      let progresoQuery = `SELECT COUNT(*) as progreso_count FROM workers WHERE status = 'REGISTERED'`;
      let publicationsQuery = `SELECT channel, COUNT(*) as count FROM publications WHERE 1=1`;
      let encuadresQuery = `SELECT COUNT(*) as encuadres_count FROM encuadres WHERE attended = true`;

      const params: any[] = [];
      let paramIndex = 1;

      if (startDate) {
        talentumQuery   += ` AND created_at >= $${paramIndex}`;
        progresoQuery   += ` AND created_at >= $${paramIndex}`;
        publicationsQuery += ` AND published_at >= $${paramIndex}`;
        encuadresQuery  += ` AND interview_date >= $${paramIndex}`;
        params.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        talentumQuery   += ` AND created_at <= $${paramIndex}`;
        progresoQuery   += ` AND created_at <= $${paramIndex}`;
        publicationsQuery += ` AND published_at <= $${paramIndex}`;
        encuadresQuery  += ` AND interview_date <= $${paramIndex}`;
        params.push(endDate);
        paramIndex++;
      }

      publicationsQuery += ` GROUP BY channel ORDER BY count DESC`;

      const [activeCases, talentum, progreso, publications, encuadres] = await Promise.all([
        this.db.query(activeCasesQuery),
        this.db.query(talentumQuery, params),
        this.db.query(progresoQuery, params),
        this.db.query(publicationsQuery, params),
        this.db.query(encuadresQuery, params),
      ]);

      const metrics = {
        activeCasesCount: parseInt(activeCases.rows[0]?.active_cases_count || '0'),
        searchingCount: parseInt(activeCases.rows[0]?.searching_count || '0'),
        searchingReplacementCount: parseInt(activeCases.rows[0]?.searching_replacement_count || '0'),
        postulantesInTalentumCount: parseInt(talentum.rows[0]?.talentum_count || '0'),
        candidatosEnProgresoCount: parseInt(progreso.rows[0]?.progreso_count || '0'),
        cantidadEncuadres: parseInt(encuadres.rows[0]?.encuadres_count || '0'),
        publicationsByChannel: publications.rows.map(row => ({
          channel: row.channel || 'Desconocido',
          count: parseInt(row.count),
        })),
        totalPubs: publications.rows.reduce((sum: number, row: any) => sum + parseInt(row.count), 0),
      };

      res.status(200).json({ success: true, data: metrics });
    } catch (error: any) {
      console.error('[RecruitmentAnalyticsController] Error fetching global metrics:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch global metrics', details: error.message });
    }
  }

  /**
   * GET /api/admin/recruitment/case/:caseNumber
   *
   * Retorna análise detalhada de um caso — pode incluir múltiplas vacantes (jp.*).
   */
  async getCaseAnalysis(req: Request, res: Response): Promise<void> {
    try {
      const { caseNumber } = req.params;

      if (!caseNumber) {
        res.status(400).json({ success: false, error: 'Case number is required' });
        return;
      }

      const caseQuery = `
        SELECT
          jp.*,
          p.first_name as patient_first_name,
          p.last_name as patient_last_name,
          p.dependency_level,
          p.diagnosis as patient_diagnosis,
          pa.neighborhood as zone_neighborhood
        FROM job_postings jp
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
        WHERE jp.case_number = $1
          AND jp.deleted_at IS NULL
      `;

      const publicationsQuery = `
        SELECT channel, COUNT(*) as count
        FROM publications p
        INNER JOIN job_postings jp ON p.job_posting_id = jp.id
        WHERE jp.case_number = $1 AND jp.deleted_at IS NULL
        GROUP BY channel ORDER BY count DESC
      `;

      const publicationsHistoryQuery = `
        SELECT p.channel, p.group_name, p.recruiter_name, p.published_at, p.observations
        FROM publications p
        INNER JOIN job_postings jp ON p.job_posting_id = jp.id
        WHERE jp.case_number = $1 AND jp.deleted_at IS NULL
        ORDER BY p.published_at DESC
      `;

      const encuadresQuery = `
        SELECT
          e.worker_raw_name, e.worker_raw_phone, e.interview_date,
          e.attended, e.resultado, e.rejection_reason,
          e.worker_raw_name as worker_name
        FROM encuadres e
        INNER JOIN job_postings jp ON e.job_posting_id = jp.id
        LEFT JOIN workers w ON e.worker_id = w.id
        WHERE jp.case_number = $1 AND jp.deleted_at IS NULL
        ORDER BY e.interview_date DESC
      `;

      const resultsQuery = `
        SELECT
          COUNT(*) FILTER (WHERE resultado = 'SELECCIONADO') as seleccionados,
          COUNT(*) FILTER (WHERE resultado = 'REEMPLAZO') as reemplazos,
          COUNT(*) FILTER (WHERE attended = true) as invitados_attended,
          COUNT(*) as total_invitados
        FROM encuadres e
        INNER JOIN job_postings jp ON e.job_posting_id = jp.id
        WHERE jp.case_number = $1 AND jp.deleted_at IS NULL
      `;

      const talentumQuery = `
        SELECT COUNT(DISTINCT e.worker_id) as postulados_count
        FROM encuadres e
        INNER JOIN job_postings jp ON e.job_posting_id = jp.id
        INNER JOIN workers w ON e.worker_id = w.id
        WHERE jp.case_number = $1 AND jp.deleted_at IS NULL AND w.status = 'REGISTERED'
      `;

      const cn = parseInt(caseNumber);
      const [caseData, publications, publicationsHistory, encuadres, results, talentum] = await Promise.all([
        this.db.query(caseQuery, [cn]),
        this.db.query(publicationsQuery, [cn]),
        this.db.query(publicationsHistoryQuery, [cn]),
        this.db.query(encuadresQuery, [cn]),
        this.db.query(resultsQuery, [cn]),
        this.db.query(talentumQuery, [cn]),
      ]);

      if (caseData.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Case not found' });
        return;
      }

      const analysis = {
        caseInfo: caseData.rows[0],
        publicationsByChannel: publications.rows.map(row => ({
          channel: row.channel || 'Desconocido',
          count: parseInt(row.count),
        })),
        publicationsHistory: publicationsHistory.rows,
        encuadres: encuadres.rows,
        metrics: {
          seleccionados: parseInt(results.rows[0]?.seleccionados || '0'),
          reemplazos: parseInt(results.rows[0]?.reemplazos || '0'),
          invitados: parseInt(results.rows[0]?.total_invitados || '0'),
          asistentes: parseInt(results.rows[0]?.invitados_attended || '0'),
          postuladosInTalentum: parseInt(talentum.rows[0]?.postulados_count || '0'),
          tasaAsistencia: results.rows[0]?.total_invitados > 0
            ? (parseInt(results.rows[0].invitados_attended) / parseInt(results.rows[0].total_invitados) * 100).toFixed(1)
            : '0',
        },
      };

      res.status(200).json({ success: true, data: analysis });
    } catch (error: any) {
      console.error('[RecruitmentAnalyticsController] Error fetching case analysis:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch case analysis', details: error.message });
    }
  }

  /**
   * GET /api/admin/recruitment/zones
   */
  async getZoneAnalysis(_req: Request, res: Response): Promise<void> {
    try {
      const query = `
        SELECT
          COALESCE(pa.neighborhood, 'Sin Zona') as zone,
          COUNT(*) as case_count,
          COUNT(*) FILTER (WHERE status IN ('SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE')) as active_count,
          json_agg(
            json_build_object(
              'case_number', case_number,
              'task_name', title,
              'status', status,
              'diagnosis', p.diagnosis,
              'patient_name', p.first_name
            )
          ) as cases
        FROM job_postings jp
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
        WHERE jp.case_number IS NOT NULL
          AND jp.deleted_at IS NULL
        GROUP BY COALESCE(pa.neighborhood, 'Sin Zona')
        ORDER BY case_count DESC
      `;

      const result = await this.db.query(query);
      const totalCases = result.rows.reduce((sum: number, row: any) => sum + parseInt(row.case_count), 0);
      const nullCount = result.rows.find((row: any) => row.zone === 'Sin Zona')?.case_count || 0;

      const analysis = {
        zones: result.rows.map((row: any) => ({
          zone: row.zone,
          caseCount: parseInt(row.case_count),
          activeCount: parseInt(row.active_count),
          percentage: ((parseInt(row.case_count) / totalCases) * 100).toFixed(1),
          cases: row.cases,
        })),
        totalCases,
        nullCount: parseInt(nullCount),
        nullPercentage: ((parseInt(nullCount) / totalCases) * 100).toFixed(1),
        identifiedZones: result.rows.filter((row: any) => row.zone !== 'Sin Zona').length,
      };

      res.status(200).json({ success: true, data: analysis });
    } catch (error: any) {
      console.error('[RecruitmentAnalyticsController] Error fetching zone analysis:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch zone analysis', details: error.message });
    }
  }

  /**
   * POST /api/admin/recruitment/calculate-reemplazos
   */
  async calculateReemplazos(_req: Request, res: Response): Promise<void> {
    try {
      const query = `
        SELECT
          jp.case_number,
          COUNT(*) FILTER (WHERE e.resultado = 'SELECCIONADO') as sel,
          COUNT(*) FILTER (WHERE e.resultado = 'REEMPLAZO') as rem,
          MAX(p.published_at) as last_pub_date,
          (
            SELECT p2.channel FROM publications p2
            WHERE p2.job_posting_id = jp.id
            ORDER BY p2.published_at DESC LIMIT 1
          ) as last_pub_channel
        FROM job_postings jp
        LEFT JOIN encuadres e ON jp.id = e.job_posting_id
        LEFT JOIN publications p ON jp.id = p.job_posting_id
        WHERE jp.case_number IS NOT NULL
          AND jp.status IN ('SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE')
          AND jp.deleted_at IS NULL
        GROUP BY jp.id, jp.case_number
        ORDER BY jp.case_number
      `;

      const result = await this.db.query(query);

      const reemplazos = result.rows.map((row: any) => {
        const sel = parseInt(row.sel || '0');
        const rem = parseInt(row.rem || '0');
        const total = sel + rem;
        let color: 'red' | 'yellow' | 'green' = 'red';
        if (sel > 0 && rem > 0) {
          color = total >= 10 ? 'green' : 'yellow';
        }
        return { caseNumber: row.case_number, sel, rem, total, color, lastPubDate: row.last_pub_date, lastPubChannel: row.last_pub_channel };
      });

      res.status(200).json({ success: true, data: reemplazos });
    } catch (error: any) {
      console.error('[RecruitmentAnalyticsController] Error calculating reemplazos:', error);
      res.status(500).json({ success: false, error: 'Failed to calculate reemplazos', details: error.message });
    }
  }
}
