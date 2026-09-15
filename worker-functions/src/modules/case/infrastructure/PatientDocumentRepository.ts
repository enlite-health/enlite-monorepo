/**
 * PatientDocumentRepository — `patient_documents` (migration 426; spec 018, PR-4, D329).
 *
 * Append-only: SEM `update`/`delete` neste repositório — a tabela só sai por CASCADE da purga
 * (revogado explicitamente na migration para `app_runtime`; este arquivo nem tenta).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { PatientDocumentContentType } from './PatientDocumentStorage';

export type PatientDocumentType = 'image_consent' | 'image_consent_revocation';

export interface PatientDocumentRow {
  id: string;
  patient_id: string;
  document_type: PatientDocumentType;
  object_path_encrypted: string;
  content_type: PatientDocumentContentType;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  uploaded_at: string;
}

export class PatientDocumentRepository {
  constructor(private readonly pool: Pool = DatabaseConnection.getInstance().getPool()) {}

  async insert(
    patientId: string,
    input: {
      documentType: PatientDocumentType;
      objectPathEncrypted: string;
      contentType: PatientDocumentContentType;
      sizeBytes: number;
      sha256: string;
    },
    actorUid: string,
    client: PoolClient,
  ): Promise<{ id: string }> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO patient_documents
         (patient_id, document_type, object_path_encrypted, content_type, size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [patientId, input.documentType, input.objectPathEncrypted, input.contentType, input.sizeBytes, input.sha256, actorUid],
    );
    return { id: rows[0].id };
  }

  /** Nunca vaza para fora do paciente — filtro composto (id, patient_id) sempre. */
  async findOne(patientId: string, documentId: string, executor: Pool | PoolClient = this.pool): Promise<PatientDocumentRow | null> {
    const { rows } = await executor.query<PatientDocumentRow>(
      `SELECT id, patient_id, document_type, object_path_encrypted, content_type, size_bytes, sha256, uploaded_by, uploaded_at
         FROM patient_documents WHERE id = $2 AND patient_id = $1`,
      [patientId, documentId],
    );
    return rows[0] ?? null;
  }

  /** Todos os documentos do paciente (usado pela purga, para apagar cada objeto do GCS). */
  async listForPatient(patientId: string, executor: Pool | PoolClient = this.pool): Promise<PatientDocumentRow[]> {
    const { rows } = await executor.query<PatientDocumentRow>(
      `SELECT id, patient_id, document_type, object_path_encrypted, content_type, size_bytes, sha256, uploaded_by, uploaded_at
         FROM patient_documents WHERE patient_id = $1`,
      [patientId],
    );
    return rows;
  }
}
