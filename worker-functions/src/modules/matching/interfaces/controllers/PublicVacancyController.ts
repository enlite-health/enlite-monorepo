import { Request, Response } from 'express';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { normalizeSchedule } from '../../infrastructure/scheduleNormalizer';

/**
 * PublicVacancyController
 *
 * Endpoint público (sem auth) para leitura de dados não-sensíveis de uma vaga.
 * Usado pela página pública de vaga (landing page de candidatos).
 *
 * PII do paciente (nome, telefone, email, documento, etc.) nunca é exposta.
 * Localização é coarse: bairro + cidade + província — nunca rua, número,
 * complemento ou coordenadas. Diagnóstico (pathologies) é exposto sem nome
 * associado, necessário para o candidato qualificar a vaga.
 */

const SLUG_REGEX = /^caso(\d+)-(\d+)$/;

export class PublicVacancyController {
  private readonly db = DatabaseConnection.getInstance().getPool();

  async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const slugMatch = SLUG_REGEX.exec(id);
      const isSlug = !!slugMatch;
      const whereClause = isSlug
        ? 'jp.case_number = $1 AND jp.vacancy_number = $2 AND jp.deleted_at IS NULL'
        : 'jp.id = $1 AND jp.deleted_at IS NULL';
      const params: (string | number)[] = isSlug
        ? [Number(slugMatch![1]), Number(slugMatch![2])]
        : [id];

      const result = await this.db.query(
        `
        SELECT
          jp.id,
          jp.case_number,
          jp.vacancy_number,
          jp.title,
          jp.status,
          p.dependency_level,
          p.diagnosis AS pathologies,
          p.service_type AS service_type,
          jp.required_professions,
          jp.required_sex,
          jp.age_range_min,
          jp.age_range_max,
          jp.worker_attributes,
          jp.schedule,
          jp.schedule_days_hours,
          jp.salary_text,
          jp.talentum_description,
          jp.talentum_whatsapp_url,
          jp.country,
          jp.created_at,
          COALESCE(
            NULLIF(CONCAT_WS(', ',
              COALESCE(pa.neighborhood, p.zone_neighborhood),
              pa.city,
              pa.state
            ), ''),
            jp.inferred_zone
          ) AS patient_zone
        FROM job_postings jp
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
        WHERE ${whereClause}
        `,
        params,
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const row = result.rows[0];
      row.schedule = normalizeSchedule(row.schedule);

      res.status(200).json({ success: true, data: row });
    } catch (error: unknown) {
      console.error('[PublicVacancyController] Error fetching vacancy:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch vacancy' });
    }
  }
}
