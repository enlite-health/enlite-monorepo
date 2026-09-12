import { Request, Response } from 'express';
import { GCSStorageService, DocumentType } from '../../infrastructure/GCSStorageService';
import { WorkerDocumentsRepository } from '../../infrastructure/WorkerDocumentsRepository';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { UploadWorkerDocumentsUseCase } from '../../application/UploadWorkerDocumentsUseCase';
import { ValidateWorkerDocumentUseCase } from '../../application/ValidateWorkerDocumentUseCase';
import { IWorkerRepository } from '../../ports/IWorkerRepository';
import { maskEmailForLog } from '@shared/utils/emailMask';

const VALID_DOC_TYPES: DocumentType[] = [
  'resume_cv', 'identity_document', 'identity_document_back', 'criminal_record',
  'professional_registration', 'liability_insurance',
  'monotributo_certificate', 'at_certificate',
  'apto_psicofisico', 'analitico_universitario', 'carta_recomendacion',
];

const DOC_JS_FIELD: Record<DocumentType, string> = {
  resume_cv: 'resumeCvUrl',
  identity_document: 'identityDocumentUrl',
  identity_document_back: 'identityDocumentBackUrl',
  criminal_record: 'criminalRecordUrl',
  professional_registration: 'professionalRegistrationUrl',
  liability_insurance: 'liabilityInsuranceUrl',
  monotributo_certificate: 'monotributoCertificateUrl',
  at_certificate: 'atCertificateUrl',
  apto_psicofisico: 'aptoPsicofisicoUrl',
  analitico_universitario: 'analiticoUniversitarioUrl',
  carta_recomendacion: 'cartaRecomendacionUrl',
};

const DOC_SQL_COL: Record<DocumentType, string> = {
  resume_cv: 'resume_cv_url',
  identity_document: 'identity_document_url',
  identity_document_back: 'identity_document_back_url',
  criminal_record: 'criminal_record_url',
  professional_registration: 'professional_registration_url',
  liability_insurance: 'liability_insurance_url',
  monotributo_certificate: 'monotributo_certificate_url',
  at_certificate: 'at_certificate_url',
  apto_psicofisico: 'apto_psicofisico_url',
  analitico_universitario: 'analitico_universitario_url',
  carta_recomendacion: 'carta_recomendacion_url',
};

interface AdminUser {
  uid: string;
  email?: string;
  roles?: string[];
}

/**
 * Admin endpoints for managing worker documents.
 * All operations log the admin identity clearly for audit purposes.
 */
export class AdminWorkerDocumentsController {
  private readonly gcs = new GCSStorageService();
  private readonly documentsRepo: WorkerDocumentsRepository;
  private readonly workerRepo: IWorkerRepository;
  private readonly uploadUseCase: UploadWorkerDocumentsUseCase;

  constructor() {
    const pool = DatabaseConnection.getInstance().getPool();
    this.workerRepo = new WorkerRepository();
    this.documentsRepo = new WorkerDocumentsRepository(pool);
    this.uploadUseCase = new UploadWorkerDocumentsUseCase(this.documentsRepo, this.workerRepo);
  }

  private getAdminUser(req: Request): AdminUser | null {
    const user = (req as any).user;
    return user?.uid ? user : null;
  }

  async getUploadSignedUrl(req: Request, res: Response): Promise<void> {
    try {
      const admin = this.getAdminUser(req);
      if (!admin) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { id: workerId } = req.params;
      const { docType, contentType } = req.body as { docType: unknown; contentType?: unknown };

      console.log('[AdminWorkerDocs.getUploadSignedUrl] ADMIN_ACTION | adminUid:', admin.uid,
        '| workerId:', workerId, '| docType:', docType);

      if (!docType || !VALID_DOC_TYPES.includes(docType as DocumentType)) {
        res.status(400).json({ success: false, error: `docType must be one of: ${VALID_DOC_TYPES.join(', ')}` }); return;
      }
      const VALID_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
      const resolvedContentType = typeof contentType === 'string' && VALID_CONTENT_TYPES.includes(contentType)
        ? contentType : 'application/pdf';

      const result = await this.gcs.generateUploadSignedUrl(workerId, docType as DocumentType, resolvedContentType);
      console.log('[AdminWorkerDocs.getUploadSignedUrl] SUCCESS | adminEmail:', maskEmailForLog(admin.email), '| workerId:', workerId, '| filePath:', result.filePath);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('[AdminWorkerDocs.getUploadSignedUrl] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async saveDocumentPath(req: Request, res: Response): Promise<void> {
    try {
      const admin = this.getAdminUser(req);
      if (!admin) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { id: workerId } = req.params;
      const { docType, filePath } = req.body as { docType: unknown; filePath: unknown };

      console.log('[AdminWorkerDocs.saveDocumentPath] ADMIN_UPLOAD | adminUid:', admin.uid,
        '| workerId:', workerId, '| docType:', docType);

      if (!docType || !VALID_DOC_TYPES.includes(docType as DocumentType) || !filePath) {
        res.status(400).json({ success: false, error: 'docType and filePath are required' }); return;
      }

      const jsField = DOC_JS_FIELD[docType as DocumentType];
      const docs = await this.uploadUseCase.execute({
        workerId,
        [jsField]: filePath as string,
      });

      // Record admin audit trail
      await this.recordAdminUpload(workerId, admin);

      console.log('[AdminWorkerDocs.saveDocumentPath] SUCCESS | UPLOADED_BY_ADMIN | adminEmail:', maskEmailForLog(admin.email),
        '| workerId:', workerId, '| docType:', docType, '| newStatus:', docs.documentsStatus);
      res.status(200).json({ success: true, data: docs });
    } catch (err) {
      console.error('[AdminWorkerDocs.saveDocumentPath] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getViewSignedUrl(req: Request, res: Response): Promise<void> {
    try {
      const admin = this.getAdminUser(req);
      if (!admin) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { filePath } = req.body as { filePath: unknown };

      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ success: false, error: 'filePath is required' }); return;
      }

      const signedUrl = await this.gcs.generateViewSignedUrl(filePath);
      res.status(200).json({ success: true, data: { signedUrl } });
    } catch (err) {
      console.error('[AdminWorkerDocs.getViewSignedUrl] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async deleteDocument(req: Request, res: Response): Promise<void> {
    try {
      const admin = this.getAdminUser(req);
      if (!admin) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { id: workerId, type: docType } = req.params;

      console.log('[AdminWorkerDocs.deleteDocument] ADMIN_DELETE | adminUid:', admin.uid,
        '| workerId:', workerId, '| docType:', docType);

      if (!VALID_DOC_TYPES.includes(docType as DocumentType)) {
        res.status(400).json({ success: false, error: 'Invalid document type' }); return;
      }

      const existing = await this.documentsRepo.findByWorkerId(workerId);
      const filePath = (existing as Record<string, string | undefined> | null)?.[DOC_JS_FIELD[docType as DocumentType]];
      if (filePath) { await this.gcs.deleteFile(filePath); }

      let updatedDocs = existing;
      if (existing) {
        await this.documentsRepo.clearDocumentField(workerId, DOC_SQL_COL[docType as DocumentType], docType);
        updatedDocs = await this.documentsRepo.update({ workerId });
        await this.workerRepo.recalculateStatus(workerId);
      }

      // Record admin audit trail
      await this.recordAdminUpload(workerId, admin);

      console.log('[AdminWorkerDocs.deleteDocument] SUCCESS | DELETED_BY_ADMIN | adminEmail:', maskEmailForLog(admin.email),
        '| workerId:', workerId, '| docType:', docType);
      res.status(200).json({ success: true, data: updatedDocs });
    } catch (err) {
      console.error('[AdminWorkerDocs.deleteDocument] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async validateDocument(req: Request, res: Response): Promise<void> {
    try {
      const admin = this.getAdminUser(req);
      if (!admin) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { id: workerId, type: docType } = req.params;

      console.log('[AdminWorkerDocs.validateDocument] ADMIN_ACTION | adminUid:', admin.uid,
        '| workerId:', workerId, '| docType:', docType);

      const useCase = new ValidateWorkerDocumentUseCase(this.documentsRepo);
      const docs = await useCase.execute({
        workerId,
        docType,
        adminEmail: admin.email ?? '',
      });

      console.log('[AdminWorkerDocs.validateDocument] SUCCESS | adminEmail:', maskEmailForLog(admin.email),
        '| workerId:', workerId, '| docType:', docType);
      res.status(200).json({ success: true, data: docs });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      const isClientError = message.startsWith('Invalid document type') ||
        message.startsWith('Cannot validate') ||
        message.startsWith('Worker documents not found');
      console.error('[AdminWorkerDocs.validateDocument] ERROR:', err);
      res.status(isClientError ? 400 : 500).json({ success: false, error: message });
    }
  }

  async invalidateDocument(req: Request, res: Response): Promise<void> {
    try {
      const admin = this.getAdminUser(req);
      if (!admin) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { id: workerId, type: docType } = req.params;

      console.log('[AdminWorkerDocs.invalidateDocument] ADMIN_ACTION | adminUid:', admin.uid,
        '| workerId:', workerId, '| docType:', docType);

      if (!VALID_DOC_TYPES.includes(docType as DocumentType)) {
        res.status(400).json({ success: false, error: `Invalid document type: ${docType}` }); return;
      }

      const docs = await this.documentsRepo.clearDocumentValidation(workerId, docType);

      console.log('[AdminWorkerDocs.invalidateDocument] SUCCESS | adminEmail:', maskEmailForLog(admin.email),
        '| workerId:', workerId, '| docType:', docType);
      res.status(200).json({ success: true, data: docs });
    } catch (err) {
      console.error('[AdminWorkerDocs.invalidateDocument] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  private async recordAdminUpload(workerId: string, admin: AdminUser): Promise<void> {
    try {
      const pool = DatabaseConnection.getInstance().getPool();
      await pool.query(
        `UPDATE worker_documents
         SET last_uploaded_by_admin_id = $2,
             last_uploaded_by_admin_email = $3,
             last_uploaded_at = NOW(),
             updated_at = NOW()
         WHERE worker_id = $1`,
        [workerId, admin.uid, admin.email ?? null],
      );
    } catch (err) {
      // Non-critical — log but don't fail the main operation
      console.error('[AdminWorkerDocs.recordAdminUpload] audit trail failed:', err);
    }
  }
}
