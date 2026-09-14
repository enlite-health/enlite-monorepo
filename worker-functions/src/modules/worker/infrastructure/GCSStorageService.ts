import admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '@shared/logging';
import { matchesOwnedDocumentPrefix } from '../domain/documentPathGuard';

/**
 * Lançado por `generateViewSignedUrl` / `deleteFile` quando o `filePath`
 * pedido não tem a forma de um documento do PRÓPRIO `workerId` esperado —
 * 2ª camada de defesa (hotfix 13/09): mesmo que um controller erre e deixe
 * passar um caminho de outro worker, o serviço de storage recusa sozinho,
 * fechado por padrão. Os controllers capturam este erro e respondem 404
 * uniforme — nunca 403, nunca ecoando o caminho.
 */
export class DocumentPathOwnershipError extends Error {
  readonly code = 'DOCUMENT_PATH_OWNERSHIP';
  constructor(message = 'Document path does not belong to worker') {
    super(message);
    this.name = 'DocumentPathOwnershipError';
  }
}

export type DocumentType =
  | 'resume_cv'
  | 'identity_document'
  | 'identity_document_back'
  | 'criminal_record'
  | 'professional_registration'
  | 'liability_insurance'
  | 'monotributo_certificate'
  | 'at_certificate'
  | 'apto_psicofisico'
  | 'analitico_universitario'
  | 'carta_recomendacion';

export interface SignedUploadResult {
  signedUrl: string;
  filePath: string;
}

/**
 * Check if running in development mode without GCP credentials.
 * In this mode, we mock GCS operations since we can't sign URLs.
 * 
 * In Cloud Run, Application Default Credentials (ADC) are used automatically
 * via the service account attached to the Cloud Run service.
 */
function isMockMode(): boolean {
  // If explicitly disabled mock via env var
  if (process.env.DISABLE_GCS_MOCK === 'true') return false;
  
  // Check if we're in development/test without proper GCP credentials
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const hasNoCredentials = !process.env.GCP_PROJECT_ID;
  
  return isDev && hasNoCredentials;
}

export class GCSStorageService {
  private readonly bucketName: string;
  private readonly mockMode: boolean;

  constructor() {
    this.bucketName = process.env.GCS_BUCKET_NAME ?? 'enlite-worker-documents';
    this.mockMode = isMockMode();
    
    if (this.mockMode) {
      console.log('[GCSStorageService] Running in MOCK mode - uploads will be simulated');
    }
  }

  private getBucket() {
    return admin.storage().bucket(this.bucketName);
  }

  getBucketName(): string {
    return this.bucketName;
  }

  async generateAdditionalUploadSignedUrl(
    workerId: string,
    contentType = 'application/pdf',
  ): Promise<SignedUploadResult> {
    return this.signUpload(`workers/${workerId}/additional`, contentType);
  }

  async generateUploadSignedUrl(
    workerId: string,
    docType: DocumentType,
    contentType = 'application/pdf',
  ): Promise<SignedUploadResult> {
    return this.signUpload(`workers/${workerId}/${docType}`, contentType);
  }

  private async signUpload(prefix: string, contentType: string): Promise<SignedUploadResult> {
    const extMap: Record<string, string> = {
      'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
    };
    const ext = extMap[contentType] ?? 'pdf';
    const filePath = `${prefix}/${uuidv4()}.${ext}`;
    console.log('[GCSStorageService.signUpload] filePath:', filePath, '| mockMode:', this.mockMode);

    if (this.mockMode) {
      return { signedUrl: `http://localhost:8080/mock-gcs-upload?path=${encodeURIComponent(filePath)}`, filePath };
    }

    try {
      const file = this.getBucket().file(filePath);
      const [signedUrl] = await file.getSignedUrl({
        version: 'v4', action: 'write',
        expires: Date.now() + 15 * 60 * 1000, contentType,
      });
      return { signedUrl, filePath };
    } catch (error) {
      console.error('[GCSStorageService.signUpload] ERROR:', error);
      throw new Error(`Failed to generate signed URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Strip full GCS URL prefix if present, returning only the relative object path.
   * Handles cases where the frontend passes a signed URL back as a filePath.
   */
  private extractRelativePath(filePath: string): string {
    const prefix = `https://storage.googleapis.com/${this.bucketName}/`;
    if (filePath.startsWith(prefix)) {
      // Remove prefix and strip any query string (signed URL params)
      const withoutPrefix = filePath.slice(prefix.length);
      return withoutPrefix.split('?')[0];
    }
    return filePath;
  }

  async generateViewSignedUrl(filePath: string, workerId: string): Promise<string> {
    const resolvedPath = this.extractRelativePath(filePath);
    if (!matchesOwnedDocumentPrefix(resolvedPath, this.bucketName, workerId)) {
      throw new DocumentPathOwnershipError();
    }

    // Mock mode: return placeholder URL
    if (this.mockMode) {
      return `http://localhost:8080/mock-gcs-view?path=${encodeURIComponent(resolvedPath)}`;
    }

    try {
      const file = this.getBucket().file(resolvedPath);
      const [signedUrl] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000,
      });
      return signedUrl;
    } catch (error) {
      console.error('[GCSStorageService.generateViewSignedUrl] ERROR:', error);
      throw new Error(`Failed to generate view signed URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteFile(filePath: string, workerId: string): Promise<void> {
    const resolvedPath = this.extractRelativePath(filePath);
    if (!matchesOwnedDocumentPrefix(resolvedPath, this.bucketName, workerId)) {
      throw new DocumentPathOwnershipError();
    }

    // Mock mode: just log, don't actually delete
    // Hotfix 13/09 (rodada 2, R4): NUNCA loga o caminho, nem em mock mode —
    // só o workerId dono.
    if (this.mockMode) {
      console.log('[GCSStorageService] Mock delete for worker:', workerId);
      return;
    }

    const file = this.getBucket().file(resolvedPath);
    await file.delete({ ignoreNotFound: true });
  }

  /**
   * Faz upload de um Buffer diretamente para GCS.
   * Usado por IngestDocumentFromUrlUseCase para documentos baixados externamente.
   */
  async uploadBuffer(buffer: Buffer, filePath: string, contentType: string): Promise<void> {
    if (this.mockMode) {
      logger.info({ filePath, bytes: buffer.length }, '[GCSStorageService] Mock uploadBuffer');
      return;
    }

    try {
      const file = this.getBucket().file(filePath);
      await file.save(buffer, {
        metadata: { contentType },
        resumable: false,
      });
    } catch (error) {
      logger.error({ err: error, filePath }, '[GCSStorageService.uploadBuffer] ERROR');
      throw new Error(
        `Failed to upload buffer to GCS: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
