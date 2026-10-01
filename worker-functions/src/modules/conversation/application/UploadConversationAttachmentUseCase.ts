/**
 * UploadConversationAttachmentUseCase — POST .../conversation/files (spec 022, Bloco 3, T311/T312;
 * D-14). Ordem: valida (`ConversationAttachmentValidator`, pipeline completo) → sobe o objeto NOVO
 * (`ConversationAttachmentStorage`, fora de transação — chamada de rede não deve segurar conexão
 * de banco) → cifra `objectPath`/nome original (`KMSEncryptionService`) → grava `stored_files`
 * numa transação com o contexto do ator (`withActorContext` — a RLS de `stored_files`, migration
 * 462, exige `app.user_uid`/`app.user_country` carimbados, senão cai no fail-closed).
 *
 * Falha da transação DEPOIS do upload: o objeto novo fica órfão — best-effort apaga (loga se
 * também falhar; nenhuma fila de retry própria nesta spec, ao contrário de `patient_photo_orphans`
 * — D-14/D-15 não pediram uma, e criar uma tabela nova só para isto seria escopo fora do nomeado).
 */
import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { withActorContext } from '@shared/database/actorContext';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { ConversationAttachmentValidator, type AttachmentRejectionCode } from '../infrastructure/ConversationAttachmentValidator';
import { ConversationAttachmentStorage } from '../infrastructure/ConversationAttachmentStorage';

const STATUS_BY_REJECTION_CODE: Record<AttachmentRejectionCode, number> = {
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  MALICIOUS_CONTENT_DETECTED: 415,
  LEGACY_DOC_NOT_ALLOWED: 415,
};

/** Recusa do pipeline de validação (D-14) — o controller traduz `status`/`code` direto na resposta. */
export class AttachmentRejectedError extends Error {
  readonly status: number;

  constructor(
    readonly code: AttachmentRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentRejectedError';
    this.status = STATUS_BY_REJECTION_CODE[code];
  }
}

export interface UploadConversationAttachmentParams {
  conversationId: string;
  actorUid: string;
  buffer: Buffer;
  originalFilename: string;
}

export interface UploadConversationAttachmentResult {
  fileId: string;
}

export class UploadConversationAttachmentUseCase {
  constructor(
    private readonly validator: ConversationAttachmentValidator = new ConversationAttachmentValidator(),
    // Fábrica, não instância (molde `UploadPatientPhotoUseCase`, task 4.3h do PR-4): sem
    // `PATIENT_DOCUMENTS_BUCKET`, `ConversationAttachmentStorage` lança no `new` — uma instância
    // default aqui derrubaria o BOOT da API inteira (este use case é construído na montagem das
    // rotas). A fábrica só roda dentro de `execute()`, quando a rota é de fato chamada.
    private readonly storageFactory: () => ConversationAttachmentStorage = () => new ConversationAttachmentStorage(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  /** `pool` é parâmetro de `execute` (nunca default de construtor) — molde de TODAS as use cases
   *  irmãs deste módulo (`PostMessageUseCase`/`EditMessageUseCase`/...): um default de
   *  `DatabaseConnection.getInstance().getPool()` no CONSTRUTOR avalia na hora do `new`, exigindo
   *  `DATABASE_URL` mesmo em teste puro que nunca chega a rodar query nenhuma. */
  async execute(pool: Pool, params: UploadConversationAttachmentParams): Promise<UploadConversationAttachmentResult> {
    const validation = await this.validator.validate(params.buffer);
    if (!validation.ok) throw new AttachmentRejectedError(validation.code, validation.message);

    const storage = this.storageFactory();
    const { objectPath } = await storage.uploadBuffer(validation.buffer, validation.contentType);

    try {
      const [objectPathEncrypted, originalNameEncrypted] = await Promise.all([
        this.enc.encrypt(objectPath),
        this.enc.encrypt(params.originalFilename),
      ]);
      const sha256 = createHash('sha256').update(validation.buffer).digest();

      return await withActorContext(pool, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO stored_files
             (bucket, object_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, uploaded_by_uid, conversation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            storage.getBucketName(),
            objectPathEncrypted,
            originalNameEncrypted,
            validation.contentType,
            validation.buffer.byteLength,
            sha256,
            params.actorUid,
            params.conversationId,
          ],
        );
        return { fileId: rows[0].id };
      });
    } catch (err) {
      await storage.delete(objectPath).catch((deleteErr: unknown) => {
        logger.warn(
          { deleteErrCode: (deleteErr as { code?: number })?.code },
          '[UploadConversationAttachmentUseCase] objeto novo não apagado após falha do INSERT — vira órfão no bucket',
        );
      });
      throw err;
    }
  }
}
