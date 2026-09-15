/**
 * UploadPatientDocumentUseCase — POST /patients/:id/documents (prova de consentimento/revogação;
 * spec 018, PR-4, D329). `application/pdf` grava como está (sem parsing); `image/jpeg` passa pelo
 * `stripJpegMetadata` (lex-documentos #9 — nunca grava EXIF/metadados de imagem).
 */
import { createHash } from 'crypto';
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { inPatientTransaction } from './patientTransaction';
import { PatientDocumentStorage, type PatientDocumentContentType } from '../infrastructure/PatientDocumentStorage';
import { PatientDocumentRepository, type PatientDocumentType } from '../infrastructure/PatientDocumentRepository';
import { PatientPhotoOrphanRepository } from '../infrastructure/PatientPhotoOrphanRepository';
import { stripJpegMetadata } from '../infrastructure/stripJpegMetadata';
import { scheduleOpportunisticOrphanRetry } from './scheduleOpportunisticOrphanRetry';

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
    // FÁBRICA, não instância (mesmo achado de `UploadPatientPhotoUseCase`, task 4.3h):
    // `PatientDocumentStorage` lança no `new` sem `GCS_PATIENT_DOCUMENTS_BUCKET` (fail-closed). Um
    // default `= new PatientDocumentStorage()` aqui derrubaria o BOOT da API inteira sem a env — a
    // fábrica só roda dentro de `execute()`, quando a rota de documento é de fato chamada.
    private readonly storageFactory: () => PatientDocumentStorage = () => new PatientDocumentStorage(),
    private readonly repo: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
    private readonly orphanRepo: PatientPhotoOrphanRepository = new PatientPhotoOrphanRepository(),
  ) {}

  async execute(input: UploadPatientDocumentInput): Promise<{ documentId: string }> {
    if (input.buffer.byteLength > MAX_DOCUMENT_BYTES) throw new PatientDocumentTooLargeError();

    // Constrói ANTES do processamento (strip de EXIF): se o bucket não está configurado, falha
    // rápido — `PatientDocumentBucketNotConfiguredError` sobe até o controller, que devolve 503.
    const storage = this.storageFactory();
    const finalBuffer = input.contentType === 'image/jpeg' ? await stripJpegMetadata(input.buffer) : input.buffer;
    const sha256 = createHash('sha256').update(finalBuffer).digest('hex');
    const { objectPath } = await storage.uploadBuffer(finalBuffer, input.contentType);
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
      // Achado da revisão do PR-4 (item 3): fila de órfãos sem consumidor — tentativa oportunista.
      scheduleOpportunisticOrphanRetry();
      return { documentId: id };
    } catch (err) {
      // INSERT falhou (ex.: paciente inexistente/deletado sob RLS): tenta apagar o objeto direto;
      // se a exclusão TAMBÉM falhar, registra em `patient_photo_orphans` (bucket `DOCUMENTS`,
      // reason `UPLOAD_FAILED`) em vez de deixá-lo desaparecer em silêncio (achado da revisão do
      // PR-4, task 4.3h — `.catch(() => undefined)` engolia a falha de exclusão inteira; o caminho
      // cifrado JÁ existe em memória mesmo sem linha em `patient_documents`, então dá pra rastrear).
      // O erro ORIGINAL da transação sempre propaga.
      await storage.delete(objectPath).catch(async (deleteErr) => {
        logger.warn({ err: deleteErr }, '[UploadPatientDocumentUseCase] objeto não apagado após falha da transação — vira órfão');
        await this.orphanRepo.record(objectPathEncrypted!, 'DOCUMENTS', 'UPLOAD_FAILED').catch((orphanErr) => {
          logger.error({ err: orphanErr }, '[UploadPatientDocumentUseCase] também falhou ao registrar órfão do objeto');
        });
      });
      throw err;
    }
  }
}
