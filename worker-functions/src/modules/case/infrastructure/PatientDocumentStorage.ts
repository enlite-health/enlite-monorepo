/**
 * PatientDocumentStorage — GCS do bucket PRÓPRIO da prova documental (consentimento/revogação de
 * imagem; spec 018, PR-4, D329; `checklists/lex-pr4-documentos.md`).
 *
 * Mesmo desenho de `PatientPhotoStorage` (não clona `GCSStorageService`), bucket SEPARADO
 * (`GCS_PATIENT_DOCUMENTS_BUCKET`, sem fallback). Objeto sob prefixo fixo `patient-documents/`
 * (data-model.md:225) com nome UUID — nunca o nome original do arquivo, nunca `patient_id` no
 * caminho, nunca logado.
 */
import { Storage, type Bucket } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '@shared/logging';

const READ_URL_TTL_SECONDS = 300;
const OBJECT_PREFIX = 'patient-documents';

export type PatientDocumentContentType = 'application/pdf' | 'image/jpeg';

export class PatientDocumentBucketNotConfiguredError extends Error {
  constructor() {
    super('GCS_PATIENT_DOCUMENTS_BUCKET não configurado — sem fallback (lex-pr4-documentos #8/#9)');
    this.name = 'PatientDocumentBucketNotConfiguredError';
  }
}

let sharedClient: Storage | undefined;

/**
 * ⚠️ NÃO usar `STORAGE_EMULATOR_HOST` — mesmo achado medido em `PatientPhotoStorage.ts` (o SDK lê
 * essa env sozinho e derruba o prefixo `/storage/v1` do `baseUrl`, quebrando `delete()` contra o
 * fake-gcs-server com 405). A env própria deste projeto é `GCS_EMULATOR_HOST`.
 */
function getClient(): Storage {
  if (!sharedClient) {
    const emulatorHost = process.env.GCS_EMULATOR_HOST;
    sharedClient = emulatorHost
      ? new Storage({ apiEndpoint: emulatorHost, projectId: process.env.GCP_PROJECT_ID ?? 'enlite-test' })
      : new Storage(process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : undefined);
  }
  return sharedClient;
}

export interface PatientDocumentUploadResult {
  objectPath: string;
}

export class PatientDocumentStorage {
  private readonly bucketName: string;

  constructor(private readonly client: Storage = getClient()) {
    const bucket = process.env.GCS_PATIENT_DOCUMENTS_BUCKET;
    if (!bucket) throw new PatientDocumentBucketNotConfiguredError();
    this.bucketName = bucket;
  }

  private bucket(): Bucket {
    return this.client.bucket(this.bucketName);
  }

  /** Sem URL assinada de ESCRITA no navegador — upload é sempre pelo servidor (lex-documentos #9). */
  async uploadBuffer(buffer: Buffer, contentType: PatientDocumentContentType): Promise<PatientDocumentUploadResult> {
    const objectPath = `${OBJECT_PREFIX}/${uuidv4()}`;
    const file = this.bucket().file(objectPath);
    await file.save(buffer, {
      resumable: false,
      metadata: { contentType, cacheControl: 'private, no-store' },
    });
    return { objectPath };
  }

  /** Sai só pela purga do paciente (CASCADE) — nunca por PATCH/DELETE do cliente. */
  async delete(objectPath: string): Promise<void> {
    try {
      await this.bucket().file(objectPath).delete();
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 404) return;
      logger.warn({ err }, '[PatientDocumentStorage] falha ao apagar objeto — chamador decide órfão');
      throw err;
    }
  }

  /**
   * URL v4 de LEITURA, 300s — legível mesmo após revogação (é a prova de que o tratamento foi
   * lícito enquanto o consentimento vigia). Chamar só depois de checar `patient_consent_documents:read`.
   */
  async getReadSignedUrl(objectPath: string): Promise<string> {
    const [url] = await this.bucket().file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + READ_URL_TTL_SECONDS * 1000,
    });
    return url;
  }
}
