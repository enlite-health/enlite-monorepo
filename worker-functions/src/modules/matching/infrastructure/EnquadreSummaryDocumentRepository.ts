import type { PoolClient } from 'pg';

export interface InsertEnquadreSummaryParams {
  eventId: string;
  labelEncrypted: string;
  filePathEncrypted: string;
  originalNameEncrypted: string;
  sizeBytes: number;
  sha256: Buffer;
  promptVersion: string;
  createdByUid: string;
}

/**
 * EnquadreSummaryDocumentRepository — o DESTINO do resumo do enquadre (`enquadre_event_documents`, migration 521): a linha do PDF
 * ligada ao EVENTO, no molde de `PatientDocumentRepository.insertAdmissionDocument` (caminho, nome e rótulo já CIFRADOS por quem
 * chama). Um documento por evento: `ON CONFLICT DO NOTHING` devolve `null` na duplicata. SEM FK para paciente.
 */
export class EnquadreSummaryDocumentRepository {
  async insert(p: InsertEnquadreSummaryParams, client: Pick<PoolClient, 'query'>): Promise<{ id: string } | null> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO enquadre_event_documents
         (event_id, label_encrypted, file_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, prompt_version, created_by_uid)
       VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6, $7, $8)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [p.eventId, p.labelEncrypted, p.filePathEncrypted, p.originalNameEncrypted, p.sizeBytes, p.sha256, p.promptVersion, p.createdByUid],
    );
    return rows[0] ?? null;
  }
}
