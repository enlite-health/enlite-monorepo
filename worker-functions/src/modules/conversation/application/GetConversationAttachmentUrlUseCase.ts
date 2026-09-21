/**
 * GetConversationAttachmentUrlUseCase — GET .../files/:fileId/url (spec 022, Bloco 3, T314/T315).
 *
 * Posse: `fileId` precisa estar ANEXADO (`conversation_message_attachments`) a uma mensagem cuja
 * conversa pertence ao paciente `:id` da rota — molde do próprio tasks.md (T315: "verificar posse
 * (conversation_message_attachments → conversation_messages → conversations.patient_id === :id)").
 * Um arquivo já uploadado mas AINDA NÃO anexado a mensagem nenhuma (fluxo: upload separado do POST
 * de mensagem, D-14) não é baixável por esta rota ainda — condição implícita do próprio join, não
 * uma checagem extra.
 *
 * `null` (não 403/404 aqui — quem decide o código HTTP é o controller) cobre as DUAS causas SEM
 * DISTINGUIR (arquivo inexistente OU de outro paciente) — nunca vaza para o cliente qual das duas.
 */
import type { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { READ_URL_TTL_SECONDS } from '@modules/case';
import { ConversationAttachmentStorage } from '../infrastructure/ConversationAttachmentStorage';

export interface GetConversationAttachmentUrlParams {
  patientId: string;
  fileId: string;
}

export interface GetConversationAttachmentUrlResult {
  url: string;
  expiresInSeconds: number;
}

/** Remove aspas/CR/LF do nome original antes de embutir no header `Content-Disposition` — nome
 *  original vem de arquivo enviado por usuário, nunca confiar sem sanitizar. */
function sanitizeFilenameForHeader(name: string): string {
  return name.replace(/["\r\n]/g, '');
}

export class GetConversationAttachmentUrlUseCase {
  constructor(
    private readonly storageFactory: () => ConversationAttachmentStorage = () => new ConversationAttachmentStorage(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(db: Pool, params: GetConversationAttachmentUrlParams): Promise<GetConversationAttachmentUrlResult | null> {
    const { rows } = await db.query<{ objectPathEncrypted: string; originalNameEncrypted: string }>(
      `SELECT sf.object_path_encrypted AS "objectPathEncrypted", sf.original_name_encrypted AS "originalNameEncrypted"
         FROM stored_files sf
         JOIN conversation_message_attachments cma ON cma.file_id = sf.id
         JOIN conversation_messages cm ON cm.id = cma.message_id
         JOIN conversations c ON c.id = cm.conversation_id
        WHERE sf.id = $1 AND c.patient_id = $2
        LIMIT 1`,
      [params.fileId, params.patientId],
    );
    if (rows.length === 0) return null;

    const storage = this.storageFactory();
    const [objectPath, originalName] = await Promise.all([
      this.enc.decrypt(rows[0].objectPathEncrypted),
      this.enc.decrypt(rows[0].originalNameEncrypted),
    ]);

    const url = await storage.getReadSignedUrl(objectPath, {
      responseDisposition: `attachment; filename="${sanitizeFilenameForHeader(originalName)}"`,
    });
    return { url, expiresInSeconds: READ_URL_TTL_SECONDS };
  }
}
