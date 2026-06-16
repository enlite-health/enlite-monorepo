import { Request, Response } from 'express';
import { GCSStorageService, DocumentType } from '../../infrastructure/GCSStorageService';
import { WorkerDocumentsRepository } from '../../infrastructure/WorkerDocumentsRepository';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GetWorkerProgressUseCase } from '../../application/GetWorkerProgressUseCase';
import { UploadWorkerDocumentsUseCase } from '../../application/UploadWorkerDocumentsUseCase';
import { IWorkerRepository } from '../../ports/IWorkerRepository';

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

export class WorkerDocumentsMeController {
  private readonly gcs = new GCSStorageService();
  private readonly documentsRepo: WorkerDocumentsRepository;
  private readonly workerRepo: IWorkerRepository;
  private readonly getProgressUseCase: GetWorkerProgressUseCase;
  private readonly uploadUseCase: UploadWorkerDocumentsUseCase;

  constructor() {
    const pool = DatabaseConnection.getInstance().getPool();
    this.workerRepo = new WorkerRepository();
    this.documentsRepo = new WorkerDocumentsRepository(pool);
    this.getProgressUseCase = new GetWorkerProgressUseCase(this.workerRepo);
    this.uploadUseCase = new UploadWorkerDocumentsUseCase(this.documentsRepo, this.workerRepo);
  }

  private getAuthUid(req: Request): string | null {
    return (req as Request & { user?: { uid: string } }).user?.uid
      ?? (req.headers['x-auth-uid'] as string | undefined)
      ?? null;
  }

  private async resolveWorker(authUid: string): Promise<{ id: string } | null> {
    const result = await this.getProgressUseCase.execute(authUid);
    return result.isFailure ? null : result.getValue() as { id: string };
  }

  async getDocuments(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      console.log('[WorkerDocsMeCtrl.getDocuments] authUid:', authUid);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const worker = await this.resolveWorker(authUid);
      console.log('[WorkerDocsMeCtrl.getDocuments] resolved worker:', worker?.id ?? 'NOT FOUND');
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      const docs = await this.documentsRepo.findByWorkerId(worker.id);
      console.log('[WorkerDocsMeCtrl.getDocuments] docs found:', docs ? 'yes' : 'no', '| status:', docs?.documentsStatus ?? 'N/A');
      res.status(200).json({ success: true, data: docs });
    } catch (err) {
      console.error('[WorkerDocsMeCtrl.getDocuments] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getUploadSignedUrl(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      console.log('[WorkerDocsMeCtrl.getUploadSignedUrl] authUid:', authUid);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { docType, contentType } = req.body as { docType: unknown; contentType?: unknown };
      console.log('[WorkerDocsMeCtrl.getUploadSignedUrl] docType:', docType, '| contentType:', contentType);
      if (!docType || !VALID_DOC_TYPES.includes(docType as DocumentType)) {
        console.warn('[WorkerDocsMeCtrl.getUploadSignedUrl] invalid docType:', docType);
        res.status(400).json({ success: false, error: `docType must be one of: ${VALID_DOC_TYPES.join(', ')}` }); return;
      }
      const VALID_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
      const resolvedContentType = typeof contentType === 'string' && VALID_CONTENT_TYPES.includes(contentType)
        ? contentType
        : 'application/pdf';
      const worker = await this.resolveWorker(authUid);
      console.log('[WorkerDocsMeCtrl.getUploadSignedUrl] resolved worker:', worker?.id ?? 'NOT FOUND');
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      const result = await this.gcs.generateUploadSignedUrl(worker.id, docType as DocumentType, resolvedContentType);
      console.log('[WorkerDocsMeCtrl.getUploadSignedUrl] SUCCESS | filePath:', result.filePath);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('[WorkerDocsMeCtrl.getUploadSignedUrl] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async saveDocumentPath(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      console.log('[WorkerDocsMeCtrl.saveDocumentPath] authUid:', authUid);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { docType, filePath } = req.body as { docType: unknown; filePath: unknown };
      console.log('[WorkerDocsMeCtrl.saveDocumentPath] docType:', docType, '| filePath:', filePath);
      if (!docType || !VALID_DOC_TYPES.includes(docType as DocumentType) || !filePath) {
        console.warn('[WorkerDocsMeCtrl.saveDocumentPath] validation failed | docType:', docType, '| filePath:', filePath);
        res.status(400).json({ success: false, error: 'docType and filePath are required' }); return;
      }
      const worker = await this.resolveWorker(authUid);
      console.log('[WorkerDocsMeCtrl.saveDocumentPath] resolved worker:', worker?.id ?? 'NOT FOUND');
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      const jsField = DOC_JS_FIELD[docType as DocumentType];
      console.log('[WorkerDocsMeCtrl.saveDocumentPath] mapping docType →', jsField, '| calling uploadUseCase...');
      const docs = await this.uploadUseCase.execute({
        workerId: worker.id,
        [jsField]: filePath as string,
      });
      console.log('[WorkerDocsMeCtrl.saveDocumentPath] SUCCESS | workerId:', worker.id, '| docType:', docType, '| newStatus:', docs.documentsStatus);
      res.status(200).json({ success: true, data: docs });
    } catch (err) {
      console.error('[WorkerDocsMeCtrl.saveDocumentPath] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getViewSignedUrl(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      console.log('[WorkerDocsMeCtrl.getViewSignedUrl] authUid:', authUid);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { filePath } = req.body as { filePath: unknown };
      console.log('[WorkerDocsMeCtrl.getViewSignedUrl] filePath:', filePath);
      if (!filePath || typeof filePath !== 'string') {
        console.warn('[WorkerDocsMeCtrl.getViewSignedUrl] filePath missing or invalid');
        res.status(400).json({ success: false, error: 'filePath is required' }); return;
      }
      const signedUrl = await this.gcs.generateViewSignedUrl(filePath);
      console.log('[WorkerDocsMeCtrl.getViewSignedUrl] SUCCESS');
      res.status(200).json({ success: true, data: { signedUrl } });
    } catch (err) {
      console.error('[WorkerDocsMeCtrl.getViewSignedUrl] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async deleteDocument(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      const { type: docType } = req.params;
      console.log('[WorkerDocsMeCtrl.deleteDocument] authUid:', authUid, '| docType:', docType);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      if (!VALID_DOC_TYPES.includes(docType as DocumentType)) {
        console.warn('[WorkerDocsMeCtrl.deleteDocument] invalid docType:', docType);
        res.status(400).json({ success: false, error: 'Invalid document type' }); return;
      }
      const worker = await this.resolveWorker(authUid);
      console.log('[WorkerDocsMeCtrl.deleteDocument] resolved worker:', worker?.id ?? 'NOT FOUND');
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      const existing = await this.documentsRepo.findByWorkerId(worker.id);
      const filePath = (existing as Record<string, string | undefined> | null)?.[DOC_JS_FIELD[docType as DocumentType]];
      console.log('[WorkerDocsMeCtrl.deleteDocument] existing filePath:', filePath ?? 'NONE');
      if (filePath) { await this.gcs.deleteFile(filePath); }
      if (existing) {
        await this.documentsRepo.clearDocumentField(worker.id, DOC_SQL_COL[docType as DocumentType]);
        // Recalculate documents_status after removing a file: update with no new URLs so
        // determineStatusFromUpdate reads the remaining docs from the DB and recomputes status.
        await this.documentsRepo.update({ workerId: worker.id });
        await this.workerRepo.recalculateStatus(worker.id);
      }
      console.log('[WorkerDocsMeCtrl.deleteDocument] SUCCESS | workerId:', worker.id, '| docType:', docType);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('[WorkerDocsMeCtrl.deleteDocument] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
