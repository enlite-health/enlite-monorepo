/**
 * Linha do banco → DTO da lista (spec 031). Único ponto que decifra o rótulo, com o MESMO teto de
 * concorrência do KMS que o chat usa (`KMS_DECRYPT_CONCURRENCY_LIMIT`).
 *
 * Falha de decifra num item vira `label: null` (a tela cai num rótulo genérico) em vez de derrubar a
 * lista inteira — e o relato leva SÓ o UUID do documento (nunca o nome, nunca a mensagem do KMS).
 */
import { mapWithConcurrency } from '@shared/async/mapWithConcurrency';
import { reportError } from '@shared/logging';
import { KMS_DECRYPT_CONCURRENCY_LIMIT, type KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { PatientDocumentDto } from '../domain/PatientDocument';
import type { PatientDocumentRow } from '../infrastructure/PatientDocumentRepository';

export async function toPatientDocumentDtos(
  rows: PatientDocumentRow[],
  enc: Pick<KMSEncryptionService, 'decrypt'>,
): Promise<PatientDocumentDto[]> {
  const labels = await mapWithConcurrency(rows, KMS_DECRYPT_CONCURRENCY_LIMIT, async (row) => {
    try {
      return await enc.decrypt(row.labelEncrypted);
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)), {
        source: 'patient-documents:toPatientDocumentDtos',
        documentId: row.id,
      });
      return null;
    }
  });

  return rows.map((row, i) => ({
    id: row.id,
    origin: row.origin,
    label: labels[i],
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    createdByUid: row.createdByUid,
    createdByDisplayName: row.createdByDisplayName ?? null,
    labelUpdatedAt: row.labelUpdatedAt ? row.labelUpdatedAt.toISOString() : null,
  }));
}
