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

/**
 * Percent-encode conforme RFC 5987 (`ext-value`, usado no `filename*` do RFC 6266) — `attr-char`
 * exclui `'`, `(`, `)` e `*`, que `encodeURIComponent` sozinho NÃO escapa (ele deixa
 * `A-Za-z0-9-_.!~*'()` intactos). Sobre-escapar é sempre seguro (o RFC só proíbe escapar DE MENOS);
 * por isso só cobrimos os 4 caracteres que `encodeURIComponent` deixaria passar fora do conjunto.
 */
function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Achado BAIXO do gate revisao-pr (B3): `sanitizeFilenameForHeader` só tirava aspas/CR/LF — um
 * nome com acento/ñ ia CRU dentro de `filename="..."`, sem `filename*=UTF-8''<percent-encoded>`
 * (RFC 6266/5987). Sem a variante `filename*`, o nome chegava mutilado (ou o header inteiro
 * quebrava, a depender do cliente) para qualquer paciente com acento no nome do arquivo — comum em
 * espanhol/português. Agora manda os DOIS: `filename` ASCII de fallback (não-ASCII vira `_`, nunca
 * quebra clientes antigos que só leem esse parâmetro) + `filename*` com o nome real, percent-encoded.
 */
function buildAttachmentContentDisposition(originalName: string): string {
  const sanitized = sanitizeFilenameForHeader(originalName);
  const asciiFallback = sanitized.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeRFC5987ValueChars(sanitized);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
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
      responseDisposition: buildAttachmentContentDisposition(originalName),
    });
    return { url, expiresInSeconds: READ_URL_TTL_SECONDS };
  }
}
