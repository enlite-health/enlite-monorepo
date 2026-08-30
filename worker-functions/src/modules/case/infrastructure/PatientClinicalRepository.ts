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
  emergencyInstructions?: string | null;
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

  /**
   * Atualização PARCIAL com semântica de JSON Merge Patch (RFC 7396, D211.1):
   *   - chave AUSENTE (`undefined`)  → a coluna NÃO é tocada;
   *   - chave presente com `null`    → a coluna é limpa;
   *   - `has_consent` é registro legal: `null` nunca limpa (COALESCE, D108).
   *
   * Por que importa: o drawer clínico manda só o que mudou. Antes, todo campo
   * omitido virava NULL — editar só as observações apagava o diagnóstico
   * (medido no e2e, 29/08). O sync do ClickUp NÃO muda: o mapper entrega todas
   * as chaves, com `null` explícito quando o campo está vazio (D167).
   */
  async upsert(
    input: PatientClinicalUpsertInput,
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;

    const sets: string[] = [];
    const params: unknown[] = [input.patientId];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (input.diagnosis !== undefined) push('diagnosis', input.diagnosis);
    if (input.dependencyLevel !== undefined) push('dependency_level', input.dependencyLevel);
    if (input.clinicalSegments !== undefined) push('clinical_segments', input.clinicalSegments);
    if (input.serviceType !== undefined) {
      // serviceType is TEXT[] in DB after migration 139. Empty array → NULL (never store []).
      push('service_type', input.serviceType !== null && input.serviceType.length > 0 ? input.serviceType : null);
    }
    if (input.deviceType !== undefined) push('device_type', input.deviceType);
    if (input.additionalComments !== undefined) {
      push('additional_comments', input.additionalComments);
      // Autoria de additional_comments: só muda quando o campo veio no PATCH.
      // Grava o uid, nunca o valor (lex 29/08, item 3).
      params.push(input.actorUid ?? null);
      sets.push('additional_comments_updated_at = NOW()');
      sets.push(`additional_comments_updated_by = $${params.length}`);
    }
    if (input.emergencyInstructions !== undefined) {
      push('emergency_instructions', input.emergencyInstructions);
      // Autoria própria do campo (D211.2, molde de additional_comments): uid, nunca o valor.
      params.push(input.actorUid ?? null);
      sets.push('emergency_instructions_updated_at = NOW()');
      sets.push(`emergency_instructions_updated_by = $${params.length}`);
    }
    if (input.hasJudicialProtection !== undefined) push('has_judicial_protection', input.hasJudicialProtection);
    if (input.hasCud !== undefined) push('has_cud', input.hasCud);
    if (input.hasConsent !== undefined) {
      // has_consent is a LEGAL record (Ley 25.326/LGPD): null/omitted ⇒ preserved.
      // Explicit false still writes false; clearing consent is the opt-out flow's job (D108).
      params.push(input.hasConsent);
      sets.push(`has_consent = COALESCE($${params.length}, has_consent)`);
    }
    if (input.clinicalSpecialty !== undefined) push('clinical_specialty', input.clinicalSpecialty);

    // Nada veio além do id: não há o que gravar (nem bater updated_at à toa).
    if (sets.length === 0) return;

    sets.push('updated_at = NOW()');
    await executor.query(
      `UPDATE patients SET
        ${sets.join(',\n        ')}
       WHERE id = $1`,
      params,
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
        emergency_instructions AS "emergencyInstructions",
        has_judicial_protection AS "hasJudicialProtection",
        has_cud AS "hasCud", has_consent AS "hasConsent"
       FROM patients WHERE id = $1`,
      [patientId],
    );
    return result.rows[0] ?? null;
  }
}
