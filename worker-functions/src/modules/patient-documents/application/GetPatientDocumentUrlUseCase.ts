/**
 * GetPatientDocumentUrlUseCase — GET /patients/:id/documents/:docId/url (spec 031, FR-006).
 *
 * URL assinada de 300 s, pedida a cada clique, para as DUAS origens. O item do chat NÃO reusa a rota
 * do chat: ela exige `patient_conversation:read`, e quem tem a aba vê os documentos mesmo sem acesso
 * à conversa (Q11). A posse é o próprio `WHERE patient_id` do documento — `docId` de outro paciente
 * (ou de arquivo já apagado) é `null` (o controller responde 404 sem distinguir as causas).
 *
 * O download leva o nome ORIGINAL do arquivo no `Content-Disposition` (não o rótulo editável).
 */
import type { Pool } from 'pg';
import { READ_URL_TTL_SECONDS } from '@modules/case';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { ConversationAttachmentStorage } from '@modules/conversation/infrastructure/ConversationAttachmentStorage';
import { buildAttachmentContentDisposition } from '@modules/conversation/application/GetConversationAttachmentUrlUseCase';
import { PatientDocumentRepository } from '../infrastructure/PatientDocumentRepository';

export interface GetPatientDocumentUrlParams {
  patientId: string;
  docId: string;
}

export interface GetPatientDocumentUrlResult {
  url: string;
  expiresInSeconds: number;
}

export class GetPatientDocumentUrlUseCase {
  constructor(
    private readonly repository: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly storageFactory: () => ConversationAttachmentStorage = () => new ConversationAttachmentStorage(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(db: Pool, params: GetPatientDocumentUrlParams): Promise<GetPatientDocumentUrlResult | null> {
    const location = await this.repository.findFileLocation(params.patientId, params.docId, db);
    if (!location) return null;

    const [objectPath, originalName] = await Promise.all([
      this.enc.decrypt(location.pathEncrypted),
      this.enc.decrypt(location.originalNameEncrypted),
    ]);
    const url = await this.storageFactory().getReadSignedUrl(objectPath, {
      responseDisposition: buildAttachmentContentDisposition(originalName),
    });
    return { url, expiresInSeconds: READ_URL_TTL_SECONDS };
  }
}
