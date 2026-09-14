/**
 * PatientPhotoRepository — `patient_photos` (migration 426; spec 018, PR-4).
 *
 * 1 foto viva por paciente (`uq_patient_photos_one`). Trocar = apagar a linha (o use case apaga
 * o objeto do GCS antes/depois, ver `UploadPatientPhotoUseCase`) e inserir a nova — nunca UPDATE
 * do `object_path_encrypted` de uma linha existente (o objeto trocaria de referência sem o
 * antigo ser apagado em nenhum lugar).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export interface PatientPhotoRow {
  id: string;
  patient_id: string;
  consent_id: string | null;
  object_path_encrypted: string;
  content_type: 'image/jpeg';
  created_by: string;
  created_at: string;
}

export class PatientPhotoRepository {
  constructor(private readonly pool: Pool = DatabaseConnection.getInstance().getPool()) {}

  async findOne(patientId: string, executor: Pool | PoolClient = this.pool): Promise<PatientPhotoRow | null> {
    const { rows } = await executor.query<PatientPhotoRow>(
      `SELECT id, patient_id, consent_id, object_path_encrypted, content_type, created_by, created_at
         FROM patient_photos WHERE patient_id = $1`,
      [patientId],
    );
    return rows[0] ?? null;
  }

  async insert(
    patientId: string,
    input: { objectPathEncrypted: string; consentId?: string | null },
    actorUid: string,
    client: PoolClient,
  ): Promise<{ id: string }> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO patient_photos (patient_id, consent_id, object_path_encrypted, content_type, created_by)
       VALUES ($1, $2, $3, 'image/jpeg', $4)
       RETURNING id`,
      [patientId, input.consentId ?? null, input.objectPathEncrypted, actorUid],
    );
    return { id: rows[0].id };
  }

  /** Apaga a LINHA (não o objeto — isso é do storage) e devolve o que existia, para o use case apagar o objeto. */
  async deleteRow(patientId: string, client: PoolClient): Promise<PatientPhotoRow | null> {
    const { rows } = await client.query<PatientPhotoRow>(
      `DELETE FROM patient_photos WHERE patient_id = $1
       RETURNING id, patient_id, consent_id, object_path_encrypted, content_type, created_by, created_at`,
      [patientId],
    );
    return rows[0] ?? null;
  }
}
