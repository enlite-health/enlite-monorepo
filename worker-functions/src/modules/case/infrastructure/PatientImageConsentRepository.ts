/**
 * PatientImageConsentRepository — `patient_image_consents` (migration 426; spec 018, PR-4).
 *
 * Decisão do Gabriel (14/09, D335): registrar consentimento é OPCIONAL e não bloqueia nada — este
 * repositório só grava/consulta o registro quando o operador decide criar um; nenhum use case de
 * foto/documento verifica a existência de linha aqui antes de agir. `document_id` é opcional.
 * Único vigente por paciente é garantido pelo banco (`uq_patient_image_consents_vigente`).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export type ConsenterKind = 'PATIENT' | 'REPRESENTATIVE';
export type RevocationChannel = 'WRITTEN' | 'EMAIL' | 'IN_PERSON' | 'PHONE';
export type RepresentationBasis = 'PARENTAL_RESPONSIBILITY' | 'GUARDIAN_DESIGNATION';

export interface RegisterImageConsentInput {
  consenterKind: ConsenterKind;
  responsibleId?: string | null;
  documentId?: string | null;
  textVersion: string;
  consentedAt: string; // ISO
  representationBasis?: RepresentationBasis | null;
  representationVerifiedBy?: string | null;
}

export interface RevokeImageConsentInput {
  revocationDocumentId?: string | null;
  revocationChannel: RevocationChannel;
}

export interface PatientImageConsentRow {
  id: string;
  patient_id: string;
  consenter_kind: ConsenterKind;
  responsible_id: string | null;
  document_id: string | null;
  text_version: string;
  consented_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** Postgres 23505 (unique_violation) na `uq_patient_image_consents_vigente`. */
export function isVigenteUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === 'uq_patient_image_consents_vigente';
}

/** 23503 (foreign_key_violation) — documentId/responsibleId de outro paciente ou inexistente. */
export function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23503';
}

/** 23514 (check_violation) — ex.: REPRESENTATIVE sem responsibleId (pic_rep_coerente). */
export function isCheckViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23514';
}

export class PatientImageConsentRepository {
  constructor(private readonly pool: Pool = DatabaseConnection.getInstance().getPool()) {}

  async register(
    patientId: string,
    input: RegisterImageConsentInput,
    actorUid: string,
    client: PoolClient,
  ): Promise<{ id: string }> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO patient_image_consents
         (patient_id, consenter_kind, responsible_id, document_id, text_version, consented_at,
          recorded_by, representation_basis, representation_verified_by, representation_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::varchar(128), CASE WHEN $9::varchar(128) IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [
        patientId,
        input.consenterKind,
        input.responsibleId ?? null,
        input.documentId ?? null,
        input.textVersion,
        input.consentedAt,
        actorUid,
        input.representationBasis ?? null,
        input.representationVerifiedBy ?? null,
      ],
    );
    return { id: rows[0].id };
  }

  /** Único vigente do paciente (`revoked_at IS NULL`), se houver. */
  async findVigente(patientId: string, executor: Pool | PoolClient = this.pool): Promise<PatientImageConsentRow | null> {
    const { rows } = await executor.query<PatientImageConsentRow>(
      `SELECT id, patient_id, consenter_kind, responsible_id, document_id, text_version,
              consented_at, revoked_at, revoked_by
         FROM patient_image_consents
        WHERE patient_id = $1 AND revoked_at IS NULL`,
      [patientId],
    );
    return rows[0] ?? null;
  }

  /**
   * Revoga (linha nunca reescrita além destes campos — C4: a próxima registração é linha NOVA).
   * `null` quando o consentimento não existe/é de outro paciente/já estava revogado.
   */
  async revoke(
    patientId: string,
    consentId: string,
    input: RevokeImageConsentInput,
    actorUid: string,
    client: PoolClient,
  ): Promise<{ id: string } | null> {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE patient_image_consents
          SET revoked_at = now(), revoked_by = $3, revocation_channel = $4, revocation_document_id = $5
        WHERE id = $2 AND patient_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [patientId, consentId, actorUid, input.revocationChannel, input.revocationDocumentId ?? null],
    );
    return rows[0] ?? null;
  }
}
