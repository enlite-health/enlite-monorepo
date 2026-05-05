import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { MatchmakingService } from '../../infrastructure/MatchmakingService';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { UpdateEncuadreResultUseCase } from '../../application/UpdateEncuadreResultUseCase';
import { EncuadreResultado, RejectionReasonCategory } from '../../domain/Encuadre';

/**
 * VacancyMatchController
 *
 * Match, match-results, and encuadre endpoints.
 * Split from VacanciesController to respect the 400-line limit.
 */
export class VacancyMatchController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async triggerMatch(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const topN                   = req.query.top_n     ? parseInt(req.query.top_n as string)     : 20;
      const radiusKm               = req.query.radius_km ? parseInt(req.query.radius_km as string) : undefined;
      const excludeWithActiveCases = req.query.exclude_active === 'true';
      const useScoring             = req.query.use_scoring === 'true';

      const matchingService = new MatchmakingService();
      const result = await matchingService.matchWorkersForJob(id, {
        topN,
        radiusKm,
        excludeWithActiveCases,
        useScoring,
      });

      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      console.error('[VacancyMatch] Error triggering match:', error);
      res.status(500).json({ success: false, error: 'Failed to run matchmaking', details: error.message });
    }
  }

  async getMatchResults(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const limit  = Math.min(parseInt((req.query.limit  as string) || '50'), 200);
      const offset = parseInt((req.query.offset as string) || '0');

      const metaResult = await this.db.query<{ total: string; last_match_at: Date | null }>(
        `SELECT COUNT(*)::text AS total, MAX(wja.updated_at) AS last_match_at
         FROM worker_job_applications wja
         WHERE wja.job_posting_id = $1`,
        [id]
      );
      const totalCandidates = parseInt(metaResult.rows[0]?.total || '0');
      const lastMatchAt     = metaResult.rows[0]?.last_match_at ?? null;

      const result = await this.db.query(
        `SELECT
           wja.worker_id,
           wja.match_score,
           wja.internal_notes,
           wja.application_status,
           wja.messaged_at,
           w.phone,
           w.first_name_encrypted,
           w.last_name_encrypted,
           w.occupation,
           w.status,
           wl.work_zone,
           CASE
             WHEN wl.location IS NOT NULL AND pa.lat IS NOT NULL AND pa.lng IS NOT NULL
             THEN ROUND(
               (ST_Distance(wl.location, ST_MakePoint(pa.lng, pa.lat)::geography) / 1000.0)::numeric,
               1
             )::float
             ELSE NULL
           END AS distance_km,
           (
             SELECT COUNT(*)::int
             FROM encuadres ea
             JOIN job_postings jp2 ON jp2.id = ea.job_posting_id
             WHERE ea.worker_id = w.id
               AND ea.resultado = 'SELECCIONADO'
               AND jp2.is_covered = false
           ) AS active_cases_count
         FROM worker_job_applications wja
         JOIN workers w    ON w.id  = wja.worker_id
         JOIN job_postings jp ON jp.id = wja.job_posting_id
         LEFT JOIN worker_locations wl ON wl.worker_id = w.id
         LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
         WHERE wja.job_posting_id = $1
         ORDER BY wja.match_score DESC NULLS LAST
         LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      );

      const kms = new KMSEncryptionService();
      const candidates = await Promise.all(
        result.rows.map(async row => {
          const [firstName, lastName] = await Promise.all([
            kms.decrypt(row.first_name_encrypted).catch(() => null),
            kms.decrypt(row.last_name_encrypted).catch(() => null),
          ]);
          const workerName = [firstName, lastName].filter(Boolean).join(' ') || 'Nome não disponível';

          return {
            workerId:          row.worker_id,
            workerName,
            workerPhone:       row.phone,
            occupation:        row.occupation,
            workZone:          row.work_zone,
            distanceKm:        row.distance_km,
            activeCasesCount:  row.active_cases_count ?? 0,
            workerStatus:      row.status,
            matchScore:        row.match_score !== null ? parseFloat(row.match_score) : null,
            internalNotes:     row.internal_notes,
            applicationStatus: row.application_status,
            alreadyApplied:    row.application_status === 'applied',
            messagedAt:        row.messaged_at,
          };
        })
      );

      res.status(200).json({
        success: true,
        data: { jobPostingId: id, lastMatchAt, totalCandidates, candidates },
      });
    } catch (error: any) {
      console.error('[VacancyMatch] Error fetching match results:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch match results', details: error.message });
    }
  }

  async updateEncuadreResult(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { resultado, rejectionReasonCategory, rejectionReason } = req.body;

      if (!resultado) {
        res.status(400).json({ success: false, error: 'resultado is required' });
        return;
      }

      const validResultados: EncuadreResultado[] = [
        'SELECCIONADO', 'RECHAZADO', 'AT_NO_ACEPTA', 'REPROGRAMAR', 'REEMPLAZO', 'BLACKLIST', 'PENDIENTE'
      ];
      if (!validResultados.includes(resultado)) {
        res.status(400).json({ success: false, error: `Invalid resultado: ${resultado}` });
        return;
      }

      const validCategories: (RejectionReasonCategory | null | undefined)[] = [
        'DISTANCE', 'SCHEDULE_INCOMPATIBLE', 'INSUFFICIENT_EXPERIENCE',
        'SALARY_EXPECTATION', 'WORKER_DECLINED', 'OVERQUALIFIED',
        'DEPENDENCY_MISMATCH', 'OTHER', null, undefined
      ];
      if (rejectionReasonCategory && !validCategories.includes(rejectionReasonCategory)) {
        res.status(400).json({ success: false, error: `Invalid rejectionReasonCategory: ${rejectionReasonCategory}` });
        return;
      }

      const useCase = new UpdateEncuadreResultUseCase();
      const result = await useCase.execute({
        encuadreId: id,
        resultado,
        rejectionReasonCategory: rejectionReasonCategory ?? null,
        rejectionReason: rejectionReason ?? null,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('not found') ? 404 : 500;
      res.status(status).json({ success: false, error: message });
    }
  }
}
