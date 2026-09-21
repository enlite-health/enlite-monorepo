/**
 * ConversationAttachmentStorage — GCS do bucket de anexos de conversa (spec 022, Bloco 3, T310;
 * D-14/D-15). Molde direto: `PatientPhotoStorage.ts` (mesma base `PatientObjectStorageBase`,
 * mesmo padrão de nome UUID sem dado identificável no caminho do objeto).
 *
 * Diferenças de `PatientPhotoStorage`:
 *  - bucket próprio, `PATIENT_DOCUMENTS_BUCKET` (fail-closed, sem fallback — D-15, bucket só em
 *    prd, `enlite-patient-documents`);
 *  - 4 extensões possíveis (a allowlist inteira de `ConversationAttachmentPolicy`), não só `.jpg`.
 */
import type { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import { PatientObjectStorageBase } from '@modules/case/infrastructure/PatientObjectStorageBase';
import type { AllowedAttachmentContentType } from './ConversationAttachmentPolicy';

export class ConversationAttachmentBucketNotConfiguredError extends Error {
  constructor() {
    super('PATIENT_DOCUMENTS_BUCKET não configurado — sem fallback (spec 022, D-15)');
    this.name = 'ConversationAttachmentBucketNotConfiguredError';
  }
}

export interface ConversationAttachmentUploadResult {
  /** Caminho do objeto no bucket — quem chama cifra (KMS) antes de gravar em `stored_files`. */
  objectPath: string;
}

const EXTENSION_BY_CONTENT_TYPE: Record<AllowedAttachmentContentType, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export class ConversationAttachmentStorage extends PatientObjectStorageBase {
  constructor(client?: Storage) {
    super('PATIENT_DOCUMENTS_BUCKET', () => new ConversationAttachmentBucketNotConfiguredError(), client);
  }

  /** Nome UUID (sem nome original, sem patient_id no caminho — mesma regra de `PatientPhotoStorage`). */
  async uploadBuffer(buffer: Buffer, contentType: AllowedAttachmentContentType): Promise<ConversationAttachmentUploadResult> {
    const objectPath = `${uuidv4()}.${EXTENSION_BY_CONTENT_TYPE[contentType]}`;
    const file = this.bucket().file(objectPath);
    await file.save(buffer, {
      resumable: false,
      metadata: { contentType, cacheControl: 'private, max-age=0, no-store' },
    });
    return { objectPath };
  }
}
