import admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';

export type DocumentType =
  | 'resume_cv'
  | 'identity_document'
  | 'identity_document_back'
  | 'criminal_record'
  | 'professional_registration'
  | 'liability_insurance'
  | 'monotributo_certificate'
  | 'at_certificate';

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

  async generateViewSignedUrl(filePath: string): Promise<string> {
    // Mock mode: return placeholder URL
    if (this.mockMode) {
      return `http://localhost:8080/mock-gcs-view?path=${encodeURIComponent(filePath)}`;
    }

    try {
      const resolvedPath = this.extractRelativePath(filePath);
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

  async deleteFile(filePath: string): Promise<void> {
    // Mock mode: just log, don't actually delete
    if (this.mockMode) {
      console.log('[GCSStorageService] Mock delete:', filePath);
      return;
    }

    const resolvedPath = this.extractRelativePath(filePath);
    const file = this.getBucket().file(resolvedPath);
    await file.delete({ ignoreNotFound: true });
  }
}
