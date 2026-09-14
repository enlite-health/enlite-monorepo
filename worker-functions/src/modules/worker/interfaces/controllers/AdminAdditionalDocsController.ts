import { Request, Response } from 'express';
import { GCSStorageService, DocumentPathOwnershipError } from '../../infrastructure/GCSStorageService';
import { WorkerAdditionalDocumentsRepository } from '../../infrastructure/WorkerAdditionalDocumentsRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { matchesOwnedDocumentPrefix } from '../../domain/documentPathGuard';

export class AdminAdditionalDocsController {
  private readonly gcs = new GCSStorageService();
  private readonly repo: WorkerAdditionalDocumentsRepository;

  constructor() {
    const pool = DatabaseConnection.getInstance().getPool();
    this.repo = new WorkerAdditionalDocumentsRepository(pool);
  }

  async list(req: Request, res: Response): Promise<void> {
    try {
      const { id: workerId } = req.params;
      const docs = await this.repo.findByWorkerId(workerId);
      res.status(200).json({ success: true, data: docs });
    } catch (err) {
      console.error('[AdminAdditionalDocs.list] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getUploadUrl(req: Request, res: Response): Promise<void> {
    try {
      const { id: workerId } = req.params;
      const { contentType } = req.body as { contentType?: string };
      const VALID = ['application/pdf', 'image/jpeg', 'image/png'];
      const resolved = typeof contentType === 'string' && VALID.includes(contentType) ? contentType : 'application/pdf';
      const result = await this.gcs.generateAdditionalUploadSignedUrl(workerId, resolved);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('[AdminAdditionalDocs.getUploadUrl] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async save(req: Request, res: Response): Promise<void> {
    try {
      const { id: workerId } = req.params;
      const { label, filePath } = req.body as { label?: string; filePath?: string };
      if (!label || !label.trim() || label.length > 255) {
        res.status(400).json({ success: false, error: 'label is required (max 255 chars)' }); return;
      }
      if (!filePath) {
        res.status(400).json({ success: false, error: 'filePath is required' }); return;
      }
      // Hotfix 13/09 (extensão): mesma trava de prefixo do lado admin — o
      // filePath do corpo só é aceito dentro de workers/<:id>/additional/....
      if (!matchesOwnedDocumentPrefix(filePath, this.gcs.getBucketName(), workerId)) {
        console.warn('[AdminAdditionalDocs.save] DENY | workerId:', workerId, '| result: path fora do prefixo do worker');
        res.status(400).json({ success: false, error: 'filePath must belong to the target worker' }); return;
      }
      const doc = await this.repo.create({ workerId, label: label.trim(), filePath });
      res.status(201).json({ success: true, data: doc });
    } catch (err) {
      console.error('[AdminAdditionalDocs.save] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async remove(req: Request, res: Response): Promise<void> {
    try {
      const { id: workerId, docId } = req.params;
      const docs = await this.repo.findByWorkerId(workerId);
      const target = docs.find(d => d.id === docId);
      // Hotfix 13/09 (rodada 2, R3): caminho legado fora do prefixo do
      // worker não vai ao GCS, mas o registro é apagado do mesmo jeito —
      // já localizado pelo dono (:id).
      if (target) {
        if (matchesOwnedDocumentPrefix(target.filePath, this.gcs.getBucketName(), workerId)) {
          await this.gcs.deleteFile(target.filePath, workerId);
        } else {
          console.warn('[AdminAdditionalDocs.remove] legacy path fora do prefixo — record_only | workerId:', workerId, '| additionalDocId:', docId, '| result: record_only');
        }
      }
      await this.repo.deleteById(docId, workerId);
      res.status(200).json({ success: true });
    } catch (err) {
      if (err instanceof DocumentPathOwnershipError) {
        console.warn('[AdminAdditionalDocs.remove] DENY (2ª camada, GCSStorageService) | workerId:', req.params.id, '| result: path not owned');
        res.status(404).json({ success: false, error: 'Document not found' }); return;
      }
      console.error('[AdminAdditionalDocs.remove] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
