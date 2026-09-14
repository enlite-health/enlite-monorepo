import { Request, Response } from 'express';
import { GCSStorageService, DocumentType } from '../../infrastructure/GCSStorageService';
import { WorkerDocumentsRepository } from '../../infrastructure/WorkerDocumentsRepository';
import { WorkerAdditionalDocumentsRepository } from '../../infrastructure/WorkerAdditionalDocumentsRepository';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GetWorkerProgressUseCase } from '../../application/GetWorkerProgressUseCase';
import { UploadWorkerDocumentsUseCase } from '../../application/UploadWorkerDocumentsUseCase';
import { IWorkerRepository } from '../../ports/IWorkerRepository';
import { assertDocumentPathBelongsToWorker, matchesOwnedDocumentPrefix, matchesOwnedDocumentPrefixAny } from '../../domain/documentPathGuard';
import { DocumentPathOwnershipError } from '../../infrastructure/GCSStorageService';

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
  private readonly additionalDocsRepo: WorkerAdditionalDocumentsRepository;
  private readonly workerRepo: IWorkerRepository;
  private readonly getProgressUseCase: GetWorkerProgressUseCase;
  private readonly uploadUseCase: UploadWorkerDocumentsUseCase;

  constructor() {
    const pool = DatabaseConnection.getInstance().getPool();
    this.workerRepo = new WorkerRepository();
    this.documentsRepo = new WorkerDocumentsRepository(pool);
    this.additionalDocsRepo = new WorkerAdditionalDocumentsRepository(pool);
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
      console.log('[WorkerDocsMeCtrl.saveDocumentPath] docType:', docType);
      if (!docType || !VALID_DOC_TYPES.includes(docType as DocumentType) || !filePath) {
        console.warn('[WorkerDocsMeCtrl.saveDocumentPath] validation failed | docType:', docType, '| filePath present:', !!filePath);
        res.status(400).json({ success: false, error: 'docType and filePath are required' }); return;
      }
      const worker = await this.resolveWorker(authUid);
      console.log('[WorkerDocsMeCtrl.saveDocumentPath] resolved worker:', worker?.id ?? 'NOT FOUND');
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      // Hotfix 13/09 (extensão): sem esta trava, um worker gravava no PRÓPRIO
      // registro o filePath de OUTRO worker — o guard de leitura aprovava
      // (estava "no registro do dono"), e o delete então apagava o objeto
      // alheio. Fora de workers/<próprio id>/... → 400 genérico, sem ecoar o
      // caminho.
      if (!matchesOwnedDocumentPrefix(filePath, this.gcs.getBucketName(), worker.id)) {
        console.warn('[WorkerDocsMeCtrl.saveDocumentPath] DENY | actorUid:', authUid, '| workerId:', worker.id, '| docType:', docType, '| result: path fora do prefixo do próprio worker');
        res.status(400).json({ success: false, error: 'filePath must belong to the authenticated worker' }); return;
      }
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
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ success: false, error: 'filePath is required' }); return;
      }
      const worker = await this.resolveWorker(authUid);
      console.log('[WorkerDocsMeCtrl.getViewSignedUrl] resolved worker:', worker?.id ?? 'NOT FOUND');
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      const existing = await this.documentsRepo.findByWorkerId(worker.id);
      // Hotfix 13/09 (rodada 2, R1): ownedPaths precisa incluir os caminhos
      // gravados em worker_additional_documents também — a rodada 1 só
      // olhava as 11 colunas fixas de worker_documents, e por isso nenhum
      // documento ADICIONAL nunca abria (nem para o próprio dono).
      const fixedPaths = existing
        ? Object.values(DOC_JS_FIELD).map((field) => (existing as unknown as Record<string, string | undefined>)[field])
        : [];
      const additionalCertPaths = existing
        ? (existing as unknown as { additionalCertificatesUrls?: string[] }).additionalCertificatesUrls ?? []
        : [];
      const additionalDocs = await this.additionalDocsRepo.findByWorkerId(worker.id);
      const ownedPaths = [...fixedPaths, ...additionalCertPaths, ...additionalDocs.map((d) => d.filePath)];
      // Hotfix 14/09: caminho gravado no PRÓPRIO registro (ownedPaths, checagem
      // acima) pode carregar o prefixo de um worker ABSORVIDO num merge — o
      // merge reparenta worker_id na tabela, nunca move o objeto no GCS.
      const absorbedIds = await this.workerRepo.findAbsorbedWorkerIds(worker.id);
      const allowedIds = [worker.id, ...absorbedIds];
      const belongsToWorker = assertDocumentPathBelongsToWorker(filePath, this.gcs.getBucketName(), allowedIds, ownedPaths);
      if (!belongsToWorker) {
        console.warn('[WorkerDocsMeCtrl.getViewSignedUrl] DENY | actorUid:', authUid, '| workerId:', worker.id, '| result: path not owned');
        res.status(404).json({ success: false, error: 'Document not found' }); return;
      }
      const signedUrl = await this.gcs.generateViewSignedUrl(filePath, allowedIds);
      console.log('[WorkerDocsMeCtrl.getViewSignedUrl] SUCCESS');
      res.status(200).json({ success: true, data: { signedUrl } });
    } catch (err) {
      if (err instanceof DocumentPathOwnershipError) {
        console.warn('[WorkerDocsMeCtrl.getViewSignedUrl] DENY (2ª camada, GCSStorageService) | result: path not owned');
        res.status(404).json({ success: false, error: 'Document not found' }); return;
      }
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
      console.log('[WorkerDocsMeCtrl.deleteDocument] existing filePath present:', !!filePath);
      // Hotfix 13/09 (rodada 2, R3): caminho LEGADO fora de workers/<id>/
      // não chama o GCS (a 2ª camada recusaria de qualquer forma) — mas o
      // REGISTRO é sempre limpo, porque já foi localizado pelo dono
      // (worker autenticado). Antes, gcs.deleteFile lançava e o catch geral
      // devolvia 404 SEM limpar o campo — o registro ficava preso para
      // sempre porque o objeto nunca mais seria "elegível" a apagar.
      if (filePath) {
        // Hotfix 14/09: mesma lista de ids permitidos da VIEW — o caminho
        // gravado pode carregar o prefixo de um worker absorvido no merge.
        const absorbedIds = await this.workerRepo.findAbsorbedWorkerIds(worker.id);
        const allowedIds = [worker.id, ...absorbedIds];
        if (matchesOwnedDocumentPrefixAny(filePath, this.gcs.getBucketName(), allowedIds)) {
          await this.gcs.deleteFile(filePath, allowedIds);
        } else {
          console.warn('[WorkerDocsMeCtrl.deleteDocument] legacy path fora do prefixo — record_only | actorUid:', authUid, '| workerId:', worker.id, '| docType:', docType, '| result: record_only');
        }
      }
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
      if (err instanceof DocumentPathOwnershipError) {
        console.warn('[WorkerDocsMeCtrl.deleteDocument] DENY (2ª camada, GCSStorageService) | docType:', req.params.type, '| result: path not owned');
        res.status(404).json({ success: false, error: 'Document not found' }); return;
      }
      console.error('[WorkerDocsMeCtrl.deleteDocument] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
