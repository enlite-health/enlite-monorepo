import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PatientClinical } from '../domain/PatientClinical';
import type { DependencyLevel } from '../domain/enums/DependencyLevel';
import type { ClinicalSpecialty } from '../domain/enums/ClinicalSpecialty';
import type { Profession } from '../../worker/domain/enums/Profession';

export interface PatientClinicalUpsertInput {
  patientId: string;
  diagnosis?: string | null;
  dependencyLevel?: DependencyLevel | null;
  clinicalSpecialty?: ClinicalSpecialty | null;
  /** @deprecated Use clinicalSpecialty instead. Preserved for backward compat. */
  clinicalSegments?: string | null;
  /** TEXT[] in DB after migration 139. */
  serviceType?: Profession[] | null;
  deviceType?: string | null;
  additionalComments?: string | null;
  hasJudicialProtection?: boolean | null;
  hasCud?: boolean | null;
  hasConsent?: boolean | null;
  /**
   * uid do staff que está editando (REQ-01/D195). Só é gravado quando
   * `additionalComments` veio no input — é a autoria DESSE campo, não do bloco.
   */
  actorUid?: string | null;
}

/**
 * PatientClinicalRepository — persists clinical fields of a patient.
 * Backed by Postgres TODAY. Future: Healthcare API (month 9).
 * Does NOT join workers, job_postings, or any domain outside patient.
 */
export class PatientClinicalRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async upsert(
    input: PatientClinicalUpsertInput,
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;

    // serviceType is TEXT[] in DB after migration 139.
    // Pass null when empty array to avoid storing [].
    const serviceTypeValue =
      input.serviceType !== undefined && input.serviceType !== null && input.serviceType.length > 0
        ? input.serviceType
        : null;

    await executor.query(
      `UPDATE patients SET
        diagnosis               = $2,
        dependency_level        = $3,
        clinical_segments       = $4,
        service_type            = $5,
        device_type             = $6,
        additional_comments     = $7,
        has_judicial_protection = $8,
        has_cud                 = $9,
        has_consent             = COALESCE($10, has_consent),
        clinical_specialty      = $11,
        -- Autoria de additional_comments: só muda quando o campo veio no PATCH
        -- ($12 = veio?). Grava o uid ($13), nunca o valor (lex 29/08, item 3).
        additional_comments_updated_at = CASE WHEN $12::boolean THEN NOW() ELSE additional_comments_updated_at END,
        additional_comments_updated_by = CASE WHEN $12::boolean THEN $13 ELSE additional_comments_updated_by END,
        updated_at              = NOW()
       WHERE id = $1`,
      [
        input.patientId,
        input.diagnosis              ?? null,
        input.dependencyLevel        ?? null,
        input.clinicalSegments       ?? null,
        serviceTypeValue,
        input.deviceType             ?? null,
        input.additionalComments     ?? null,
        input.hasJudicialProtection  ?? null,
        input.hasCud                 ?? null,
        // has_consent is a LEGAL record (Ley 25.326/LGPD): omitted in a partial
        // PATCH ⇒ preserved (COALESCE above). Explicit false still writes false;
        // clearing consent is the opt-out flow's job, never an omission's (D108).
        input.hasConsent             ?? null,
        input.clinicalSpecialty      ?? null,
        input.additionalComments !== undefined,
        input.actorUid               ?? null,
      ],
    );
  }

  async findByPatientId(patientId: string): Promise<PatientClinical | null> {
    const result = await this.pool.query<PatientClinical>(
      `SELECT
        id AS "patientId",
        diagnosis, dependency_level AS "dependencyLevel",
        clinical_segments AS "clinicalSegments",
        service_type AS "serviceType", device_type AS "deviceType",
        additional_comments AS "additionalComments",
        has_judicial_protection AS "hasJudicialProtection",
        has_cud AS "hasCud", has_consent AS "hasConsent"
       FROM patients WHERE id = $1`,
      [patientId],
    );
    return result.rows[0] ?? null;
  }
}
