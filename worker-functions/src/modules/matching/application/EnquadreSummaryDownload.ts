/**
 * EnquadreSummaryDownload — o download do resumo (PDF) do evento de enquadre (spec 052, Fase 3, T-36c).
 *
 * Mesmo serviço de URL assinada e mesmo bucket (`PATIENT_DOCUMENTS_BUCKET`) do documento do paciente (`GetPatientDocumentUrlUseCase`):
 * URL de 300 s, pedida a cada clique, com o nome ORIGINAL do arquivo no `Content-Disposition`. O caminho do objeto mora CIFRADO em
 * `enquadre_event_documents` e é decifrado SÓ aqui, no servidor; a resposta leva a URL e o prazo, nunca o caminho. A posse é o próprio
 * `WHERE job_posting_id` do evento: `eventId` de outra vaga é `null` (o controller responde 404 sem distinguir a causa).
 * Quem chama já passou pela quinta célula (`enquadre_summary:read`) na rota.
 */
import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { READ_URL_TTL_SECONDS } from '@modules/case';
import { ConversationAttachmentStorage } from '@modules/conversation/infrastructure/ConversationAttachmentStorage';
import { buildAttachmentContentDisposition } from '@modules/conversation/application/GetConversationAttachmentUrlUseCase';

export interface EnquadreSummaryUrl {
  url: string;
  expiresInSeconds: number;
}

export interface EnquadreSummaryDownloadDeps {
  db: Pool;
  enc?: Pick<KMSEncryptionService, 'decrypt'>;
  storageFactory?: () => Pick<ConversationAttachmentStorage, 'getReadSignedUrl'>;
}

export class EnquadreSummaryDownload {
  constructor(private readonly deps: EnquadreSummaryDownloadDeps) {}

  async urlFor(vacancyId: string, eventId: string): Promise<EnquadreSummaryUrl | null> {
    const location = await withActorContext(this.deps.db, async (client) => {
      const { rows } = await client.query<{ file_path_encrypted: string; original_name_encrypted: string }>(
        `SELECT d.file_path_encrypted, d.original_name_encrypted
           FROM enquadre_event_documents d
           JOIN enquadre_events e ON e.id = d.event_id
          WHERE e.job_posting_id = $1 AND e.id = $2`,
        [vacancyId, eventId],
      );
      return rows[0] ?? null;
    });
    if (!location) return null;

    const enc = this.deps.enc ?? new KMSEncryptionService();
    const [objectPath, originalName] = await Promise.all([enc.decrypt(location.file_path_encrypted), enc.decrypt(location.original_name_encrypted)]);
    const storage = (this.deps.storageFactory ?? (() => new ConversationAttachmentStorage()))();
    const url = await storage.getReadSignedUrl(objectPath, { responseDisposition: buildAttachmentContentDisposition(originalName) });
    return { url, expiresInSeconds: READ_URL_TTL_SECONDS };
  }
}
