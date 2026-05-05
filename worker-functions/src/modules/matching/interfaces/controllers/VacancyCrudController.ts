import { Request, Response } from 'express';
import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { MatchmakingService } from '../../infrastructure/MatchmakingService';
import { buildInsertQuery, buildInsertParams } from './vacancyCrudHelpers';
import { EnsureVacancyShortLinkUseCase } from '../../application/EnsureVacancyShortLinkUseCase';
import { ShortLinkService } from '../../infrastructure/shortlinks/ShortLinkService';

const PUBLIC_STATUSES = new Set([
  'ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE',
]);

async function tryEnsureShortLink(pool: Pool, vacancyId: string, status: string | null | undefined): Promise<void> {
  if (!status || !PUBLIC_STATUSES.has(status)) return;
  const svc = ShortLinkService.fromEnv();
  if (!svc) {
    console.warn('[VacancyCrud] SHORT_IO not configured — skipping short-link generation');
    return;
  }
  try {
    const uc = new EnsureVacancyShortLinkUseCase(pool, svc);
    await uc.execute(vacancyId, 'site');
  } catch (err: any) {
    console.error(`[VacancyCrud] Short-link generation failed for ${vacancyId}: ${err.message}`);
  }
}

/**
 * VacancyCrudController
 *
 * Write endpoints: create, update, delete vacancies.
 * Split from VacanciesController to respect the 400-line limit.
 */
export class VacancyCrudController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async createVacancy(req: Request, res: Response): Promise<void> {
    try {
      const {
        case_number,
        title: _title,
        patient_id,
        required_professions,
        required_sex,
        age_range_min,
        age_range_max,
        worker_profile_sought,
        required_experience,
        worker_attributes,
        schedule,
        work_schedule,
        providers_needed,
        salary_text,
        payment_day,
        daily_obs,
        patient_address_id,
        status: bodyStatus,
        published_at,
        closes_at,
        updatePatient,
      } = req.body;

      // Validate patient_address_id belongs to the patient_id (if both provided)
      if (patient_address_id && patient_id) {
        const ownerCheck = await this.db.query(
          `SELECT 1
           FROM patient_addresses pa
           WHERE pa.id = $1
             AND pa.patient_id = $2`,
          [patient_address_id, patient_id],
        );
        if (ownerCheck.rows.length === 0) {
          res.status(400).json({
            success: false,
            error: 'patient_address_id não pertence ao patient_id informado',
          });
          return;
        }
      }

      const vnResult = await this.db.query(
        "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
      );
      const vacancyNumber = parseInt(vnResult.rows[0].vn);
      const computedTitle = `CASO ${case_number}-${vacancyNumber}`;

      const hasUpdate =
        updatePatient &&
        typeof updatePatient === 'object' &&
        Object.keys(updatePatient).length > 0;

      const insertArgs = {
        vacancyNumber, case_number, computedTitle, patient_id,
        required_professions, required_sex, age_range_min, age_range_max,
        worker_profile_sought, required_experience, worker_attributes,
        schedule, work_schedule, providers_needed, salary_text, payment_day,
        daily_obs, patient_address_id,
        status: bodyStatus || undefined,
        published_at: published_at ?? null,
        closes_at: closes_at ?? null,
      };

      let newVacancy: any;

      if (hasUpdate) {
        newVacancy = await this.createWithPatientUpdate(
          case_number, updatePatient, insertArgs,
        );
      } else {
        const result = await this.db.query(
          buildInsertQuery(), buildInsertParams(insertArgs),
        );
        newVacancy = result.rows[0];
      }

      setImmediate(() => {
        try {
          const matchingService = new MatchmakingService();
          matchingService.matchWorkersForJob(newVacancy.id, {})
            .then(r => console.log(`[VacancyCrud] Auto-match done for ${newVacancy.id}: ${r.candidates.length} candidates`))
            .catch(err => console.error(`[VacancyCrud] Auto-match error for ${newVacancy.id}:`, err.message));
        } catch (err: any) {
          console.warn(`[VacancyCrud] Background match unavailable for ${newVacancy.id}: ${err.message}`);
        }
        tryEnsureShortLink(this.db, newVacancy.id, newVacancy.status).catch(() => {});
      });

      res.status(201).json({ success: true, data: newVacancy });
    } catch (error: any) {
      console.error('[VacancyCrud] Error creating vacancy:', error);
      res.status(500).json({ success: false, error: 'Failed to create vacancy', details: error.message });
    }
  }

  /** Wraps insert + patient field update in a single transaction. */
  private async createWithPatientUpdate(
    case_number: any,
    updatePatient: Record<string, any>,
    insertArgs: any,
  ): Promise<any> {
    const client: PoolClient = await this.db.connect();
    try {
      await client.query('BEGIN');

      const patientRow = await client.query<{
        id: string; diagnosis: string | null; dependency_level: string | null;
      }>(
        `SELECT id, diagnosis, dependency_level FROM patients
         WHERE id = (
           SELECT patient_id FROM job_postings
           WHERE case_number = $1 AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 1
         ) FOR UPDATE`,
        [case_number],
      );

      if (patientRow.rows.length > 0) {
        const pat = patientRow.rows[0];
        const setClauses: string[] = [];
        const auditEntries: Array<{ field: string; old: string | null; new: string }> = [];

        const updateParams: unknown[] = [pat.id];
        if (updatePatient.pathology_types !== undefined) {
          updateParams.push(String(updatePatient.pathology_types));
          setClauses.push(`diagnosis = $${updateParams.length}`);
          auditEntries.push({ field: 'diagnosis', old: pat.diagnosis, new: updatePatient.pathology_types });
        }
        if (updatePatient.dependency_level !== undefined) {
          updateParams.push(String(updatePatient.dependency_level));
          setClauses.push(`dependency_level = $${updateParams.length}`);
          auditEntries.push({ field: 'dependency_level', old: pat.dependency_level, new: updatePatient.dependency_level });
        }

        if (setClauses.length > 0) {
          await client.query(
            `UPDATE patients SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
            updateParams,
          );
          for (const e of auditEntries) {
            await client.query(
              `INSERT INTO patient_field_overrides_audit
                 (patient_id, field_name, old_value, new_value, source)
               VALUES ($1, $2, $3, $4, 'vacancy_create_pdf')`,
              [pat.id, e.field, e.old, e.new],
            );
          }
        }
      }

      const result = await client.query(buildInsertQuery(), buildInsertParams(insertArgs));
      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateVacancy(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates = req.body;

      const CANONICAL_STATUSES = new Set([
        'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE',
        'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CLOSED',
      ]);
      if (updates.status !== undefined && !CANONICAL_STATUSES.has(updates.status)) {
        res.status(400).json({
          success: false,
          error: `Invalid status value "${updates.status}". Must be one of: ${[...CANONICAL_STATUSES].join(', ')}`,
        });
        return;
      }

      const allowedFields = [
        'title', 'case_number', 'patient_id', 'patient_address_id',
        'required_professions', 'required_sex',
        'age_range_min', 'age_range_max',
        'worker_profile_sought', 'required_experience', 'worker_attributes',
        'schedule', 'work_schedule',
        'providers_needed', 'salary_text', 'payment_day',
        'daily_obs', 'status',
        'published_at', 'closes_at',
      ];

      const jsonbFields = new Set(['schedule']);
      const setClause: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      Object.keys(updates).forEach(key => {
        if (allowedFields.includes(key)) {
          let value = updates[key];
          if (jsonbFields.has(key) && typeof value === 'object' && value !== null) {
            value = JSON.stringify(value);
          }
          setClause.push(`${key} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
      });

      if (setClause.length === 0) {
        res.status(400).json({ success: false, error: 'No valid fields to update' });
        return;
      }

      values.push(id);
      const result = await this.db.query(
        `UPDATE job_postings SET ${setClause.join(', ')}, updated_at = NOW()
         WHERE id = $${paramIndex} RETURNING *`,
        values,
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const updated = result.rows[0];
      setImmediate(() => {
        tryEnsureShortLink(this.db, id, updated.status).catch(() => {});
      });

      res.status(200).json({ success: true, data: updated });
    } catch (error: any) {
      console.error('[VacancyCrud] Error updating vacancy:', error);
      res.status(500).json({ success: false, error: 'Failed to update vacancy', details: error.message });
    }
  }

  async deleteVacancy(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await this.db.query(
        `UPDATE job_postings SET status = 'CLOSED', updated_at = NOW() WHERE id = $1 RETURNING id`,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }
      res.status(200).json({ success: true, message: 'Vacancy deleted successfully' });
    } catch (error: any) {
      console.error('[VacancyCrud] Error deleting vacancy:', error);
      res.status(500).json({ success: false, error: 'Failed to delete vacancy', details: error.message });
    }
  }
}
