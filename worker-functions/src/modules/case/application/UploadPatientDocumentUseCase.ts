/**
 * UploadPatientDocumentUseCase — POST /patients/:id/documents (prova de consentimento/revogação;
 * spec 018, PR-4, D329). `application/pdf` grava como está (sem parsing); `image/jpeg` passa pelo
 * `stripJpegMetadata` (lex-documentos #9 — nunca grava EXIF/metadados de imagem).
 */
import { createHash } from 'crypto';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { inPatientTransaction } from './patientTransaction';
import { PatientDocumentStorage, type PatientDocumentContentType } from '../infrastructure/PatientDocumentStorage';
import { PatientDocumentRepository, type PatientDocumentType } from '../infrastructure/PatientDocumentRepository';
import { stripJpegMetadata } from '../infrastructure/stripJpegMetadata';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export class PatientDocumentTooLargeError extends Error {
  constructor() {
    super('Documento maior que o limite (10 MB)');
    this.name = 'PatientDocumentTooLargeError';
  }
}

export interface UploadPatientDocumentInput {
  patientId: string;
  buffer: Buffer;
  contentType: PatientDocumentContentType;
  documentType: PatientDocumentType;
  actorUid: string;
}

export class UploadPatientDocumentUseCase {
  constructor(
    private readonly storage: PatientDocumentStorage = new PatientDocumentStorage(),
    private readonly repo: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(input: UploadPatientDocumentInput): Promise<{ documentId: string }> {
    if (input.buffer.byteLength > MAX_DOCUMENT_BYTES) throw new PatientDocumentTooLargeError();

    const finalBuffer = input.contentType === 'image/jpeg' ? await stripJpegMetadata(input.buffer) : input.buffer;
    const sha256 = createHash('sha256').update(finalBuffer).digest('hex');
    const { objectPath } = await this.storage.uploadBuffer(finalBuffer, input.contentType);
    const objectPathEncrypted = await this.enc.encrypt(objectPath);

    try {
      const { id } = await inPatientTransaction((client) =>
        this.repo.insert(
          input.patientId,
          {
            documentType: input.documentType,
            objectPathEncrypted: objectPathEncrypted!,
            contentType: input.contentType,
            sizeBytes: finalBuffer.byteLength,
            sha256,
          },
          input.actorUid,
          client,
        ),
      );
      return { documentId: id };
    } catch (err) {
      // INSERT falhou (ex.: paciente inexistente/deletado sob RLS): o objeto some junto, sem
      // linha que o referencie (nunca vira órfão rastreado — não existe caminho cifrado gravado).
      await this.storage.delete(objectPath).catch(() => undefined);
      throw err;
    }
  }
}
