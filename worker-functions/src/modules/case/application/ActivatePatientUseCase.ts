import * as functions from 'firebase-functions';
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { buildInsertQuery, buildInsertParams } from '@modules/matching';

/**
 * Thrown when the patient does not exist (or was soft-deleted). The controller
 * maps this to a 404.
 */
export class PatientNotFoundError extends Error {
  constructor(patientId: string) {
    super(`Patient not found: ${patientId}`);
    this.name = 'PatientNotFoundError';
  }
}

/**
 * Thrown when the patient has zero non-archived addresses. Activation generates
 * one draft vacancy PER location — with no location there is nothing to create,
 * so we refuse (422) instead of moving the patient to ACTIVE with no vacancy.
 */
export class NoActiveAddressError extends Error {
  constructor(patientId: string) {
    super(
      `No se puede activar el paciente sin ninguna localización (dirección activa). ` +
        `Agregá al menos una dirección antes de activar. (patientId=${patientId})`,
    );
    this.name = 'NoActiveAddressError';
  }
}

export interface ActivatePatientResult {
  patientId: string;
  status: 'ACTIVE';
  createdVacancyIds: string[];
  /** true when the patient was already ACTIVE — idempotent no-op, no vacancy created. */
  alreadyActive: boolean;
}

/**
 * ActivatePatientUseCase — decisão D5 (plano-app-pacientes §6 Fase 2).
 *
 * Activating a patient means: "the service was approved; open the recruitment
 * for it". The service is defined BY LOCATION (D5: the draft vacancy per address
 * IS the contracted-service-by-location — no separate table). So activation:
 *
 *   1. Loads the patient (must exist, must not already be ACTIVE).
 *   2. For EACH non-archived patient_address, creates ONE draft job_posting
 *      through the SAME insert used by POST /api/admin/vacancies
 *      (buildInsertQuery/buildInsertParams — no duplicated SQL). The vacancy is
 *      born is_draft=true (DB default, migration 168), status 'PENDING_ACTIVATION'
 *      and salary_text 'A convenir' (buildInsertParams defaults). Minimal fields
 *      only — the operator completes each draft later.
 *   3. Moves the patient to ACTIVE.
 *
 * Everything runs in ONE transaction: either every draft vacancy + the status
 * move commit together, or nothing does. This is stronger than "create vacancies
 * then moveStatus" (two transactions) because a crash between the two would leave
 * the patient non-ACTIVE with orphan drafts — and a retry would DUPLICATE them.
 *
 * Idempotency: a patient already ACTIVE returns { alreadyActive: true,
 * createdVacancyIds: [] } without creating anything (no duplicate vacancies).
 *
 * NOTE (deliberate): unlike VacancyCrudController.createVacancy, this use case
 * does NOT emit a `vacancy.created` domain event. That event drives
 * VacancyAutoInviteHandler, which runs matchmaking + WhatsApp auto-invite and
 * only skips on is_test — NOT on is_draft. These are incomplete rascunhos
 * ('A convenir', no requirements) that must be completed by hand before they
 * recruit anyone, so firing matchmaking here would be wrong.
 */
export class ActivatePatientUseCase {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async execute(patientId: string): Promise<ActivatePatientResult> {
    const startMs = Date.now();
    const client: PoolClient = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const patientRes = await client.query<{ id: string; status: string; case_number: number | null }>(
        `SELECT id, status, case_number
           FROM patients
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [patientId],
      );

      if ((patientRes.rowCount ?? 0) === 0) {
        // Throw — the single catch below rolls back once (avoids double ROLLBACK).
        throw new PatientNotFoundError(patientId);
      }

      const { status, case_number } = patientRes.rows[0];

      // Idempotent: already ACTIVE → do not create a second set of vacancies.
      if (status === 'ACTIVE') {
        await client.query('ROLLBACK');
        functions.logger.info('activate_patient.noop_already_active', { patientId });
        return { patientId, status: 'ACTIVE', createdVacancyIds: [], alreadyActive: true };
      }

      const addrRes = await client.query<{ id: string }>(
        `SELECT id
           FROM patient_addresses
          WHERE patient_id = $1 AND archived_at IS NULL
          ORDER BY display_order ASC, created_at ASC`,
        [patientId],
      );

      if ((addrRes.rowCount ?? 0) === 0) {
        // Throw — the single catch below rolls back once (avoids double ROLLBACK).
        throw new NoActiveAddressError(patientId);
      }

      const createdVacancyIds: string[] = [];
      for (const addr of addrRes.rows) {
        // Same vacancy_number sequence + title convention as createVacancy.
        const vnRes = await client.query<{ vn: string }>(
          "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
        );
        const vacancyNumber = parseInt(vnRes.rows[0].vn, 10);
        const computedTitle = `CASO ${case_number}-${vacancyNumber}`;

        // Minimal draft: only patient_id, case_number, patient_address_id.
        // Everything else falls back to the buildInsertParams defaults
        // (salary_text 'A convenir', status 'PENDING_ACTIVATION',
        // required_professions []) and the DB defaults (is_draft true).
        const params = buildInsertParams({
          vacancyNumber,
          case_number,
          computedTitle,
          patient_id: patientId,
          patient_address_id: addr.id,
          required_professions: null,
          required_sex: null,
          age_range_min: null,
          age_range_max: null,
          worker_profile_sought: null,
          required_experience: null,
          worker_attributes: null,
          schedule: null,
          work_schedule: null,
          providers_needed: null,
          salary_text: null,
          payment_day: null,
          daily_obs: null,
          status: undefined,
          published_at: null,
          closes_at: null,
          is_test: false,
        });

        const insRes = await client.query<{ id: string }>(buildInsertQuery(), params);
        createdVacancyIds.push(insRes.rows[0].id);
      }

      // Move to ACTIVE in the SAME transaction (same UPDATE as PatientService.moveStatus).
      await client.query(
        `UPDATE patients SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`,
        [patientId],
      );

      await client.query('COMMIT');

      functions.logger.info('activate_patient.completed', {
        patientId,
        createdVacancyCount: createdVacancyIds.length,
        createdVacancyIds,
        durationMs: Date.now() - startMs,
      });

      return { patientId, status: 'ACTIVE', createdVacancyIds, alreadyActive: false };
    } catch (err) {
      // Best-effort rollback for the unexpected-error path (the explicit
      // early-return paths above already rolled back before throwing).
      try {
        await client.query('ROLLBACK');
      } catch {
        /* transaction already closed */
      }
      if (!(err instanceof PatientNotFoundError) && !(err instanceof NoActiveAddressError)) {
        functions.logger.error('activate_patient.failed', {
          patientId,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
        });
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
