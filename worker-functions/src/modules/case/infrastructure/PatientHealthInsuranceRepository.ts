import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export interface PatientHealthInsuranceUpsertInput {
  patientId: string;
  providerName?: string | null;
  plan?: string | null;
  memberId?: string | null;
  emergencyNumbers?: string[] | null;
  source?: 'clickup' | 'manual';
}

export interface PatientHealthInsurance {
  id: string;
  patientId: string;
  providerName: string | null;
  plan: string | null;
  memberId: string | null;
  emergencyNumbers: string[];
  source: 'clickup' | 'manual';
  createdAt: Date;
  updatedAt: Date;
}

/**
 * PatientHealthInsuranceRepository — persists health insurance coverage for a patient.
 * Backed by patient_health_insurance (1:1 with patients — UNIQUE on patient_id).
 * Created in migration 184. Replaces the legacy columns in patients:
 *   health_insurance_name, health_insurance_member_id (mig 147)
 *   insurance_informed, insurance_verified, affiliate_id (older, 100% NULL in prod)
 *
 * Fill-only semantics for ClickUp-origin fields (providerName, memberId):
 *   COALESCE(existing, EXCLUDED) — does NOT overwrite a populated value.
 * UI-editable fields (plan, emergencyNumbers) are overwritten only when source='manual'.
 */
export class PatientHealthInsuranceRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async upsert(
    input: PatientHealthInsuranceUpsertInput,
    client?: PoolClient,
  ): Promise<{ id: string; created: boolean }> {
    const executor  = client ?? this.pool;
    const source    = input.source ?? 'clickup';
    const emNumbers = input.emergencyNumbers ?? null;

    const result = await executor.query<{ id: string; xmax: string }>(
      `INSERT INTO patient_health_insurance (
        patient_id,
        provider_name,
        plan,
        member_id,
        emergency_numbers,
        source
      ) VALUES ($1, $2, $3, $4, COALESCE($5::text[], '{}'), $6)
      ON CONFLICT (patient_id) DO UPDATE SET
        -- fill-only for ClickUp-origin fields: never overwrite a populated value
        provider_name     = COALESCE(patient_health_insurance.provider_name,     EXCLUDED.provider_name),
        member_id         = COALESCE(patient_health_insurance.member_id,         EXCLUDED.member_id),
        -- UI-editable fields: overwrite only when incoming source is 'manual'
        plan              = CASE
                              WHEN EXCLUDED.source = 'manual' THEN EXCLUDED.plan
                              ELSE patient_health_insurance.plan
                            END,
        emergency_numbers = CASE
                              WHEN EXCLUDED.source = 'manual' THEN EXCLUDED.emergency_numbers
                              ELSE patient_health_insurance.emergency_numbers
                            END,
        source            = EXCLUDED.source,
        updated_at        = NOW()
      RETURNING id, xmax::text`,
      [
        input.patientId,
        input.providerName ?? null,
        input.plan         ?? null,
        input.memberId     ?? null,
        emNumbers,
        source,
      ],
    );

    const row = result.rows[0];
    return { id: row.id, created: row.xmax === '0' };
  }

  async findByPatientId(
    patientId: string,
    client?: PoolClient,
  ): Promise<PatientHealthInsurance | null> {
    const executor = client ?? this.pool;

    const result = await executor.query<PatientHealthInsurance>(
      `SELECT
        id,
        patient_id        AS "patientId",
        provider_name     AS "providerName",
        plan,
        member_id         AS "memberId",
        emergency_numbers AS "emergencyNumbers",
        source,
        created_at        AS "createdAt",
        updated_at        AS "updatedAt"
       FROM patient_health_insurance
       WHERE patient_id = $1`,
      [patientId],
    );

    return result.rows[0] ?? null;
  }
}
