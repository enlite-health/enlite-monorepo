import { Request, Response } from 'express';
import { GCSStorageService, DocumentPathOwnershipError } from '../../infrastructure/GCSStorageService';
import { WorkerAdditionalDocumentsRepository } from '../../infrastructure/WorkerAdditionalDocumentsRepository';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GetWorkerProgressUseCase } from '../../application/GetWorkerProgressUseCase';
import { IWorkerRepository } from '../../ports/IWorkerRepository';
import { matchesOwnedDocumentPrefix } from '../../domain/documentPathGuard';

export class WorkerAdditionalDocsMeController {
  private readonly gcs = new GCSStorageService();
  private readonly repo: WorkerAdditionalDocumentsRepository;
  private readonly workerRepo: IWorkerRepository;
  private readonly getProgressUseCase: GetWorkerProgressUseCase;

  constructor() {
    const pool = DatabaseConnection.getInstance().getPool();
    this.workerRepo = new WorkerRepository();
    this.repo = new WorkerAdditionalDocumentsRepository(pool);
    this.getProgressUseCase = new GetWorkerProgressUseCase(this.workerRepo);
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

  async list(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const worker = await this.resolveWorker(authUid);
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      const docs = await this.repo.findByWorkerId(worker.id);
      res.status(200).json({ success: true, data: docs });
    } catch (err) {
      console.error('[AdditionalDocsMeCtrl.list] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getUploadUrl(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { contentType } = req.body as { contentType?: string };
      const VALID = ['application/pdf', 'image/jpeg', 'image/png'];
      const resolved = typeof contentType === 'string' && VALID.includes(contentType) ? contentType : 'application/pdf';
      const worker = await this.resolveWorker(authUid);
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      const result = await this.gcs.generateAdditionalUploadSignedUrl(worker.id, resolved);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('[AdditionalDocsMeCtrl.getUploadUrl] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async save(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { label, filePath } = req.body as { label?: string; filePath?: string };
      if (!label || !label.trim() || label.length > 255) {
        res.status(400).json({ success: false, error: 'label is required (max 255 chars)' }); return;
      }
      if (!filePath) {
        res.status(400).json({ success: false, error: 'filePath is required' }); return;
      }
      const worker = await this.resolveWorker(authUid);
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      // Hotfix 13/09 (extensão): mesma trava de prefixo dos documentos fixos —
      // sem ela, um worker gravava o caminho de OUTRO no próprio registro de
      // adicionais e depois o apagava via remove().
      if (!matchesOwnedDocumentPrefix(filePath, this.gcs.getBucketName(), worker.id)) {
        console.warn('[AdditionalDocsMeCtrl.save] DENY | actorUid:', authUid, '| workerId:', worker.id, '| result: path fora do prefixo do próprio worker');
        res.status(400).json({ success: false, error: 'filePath must belong to the authenticated worker' }); return;
      }
      const doc = await this.repo.create({ workerId: worker.id, label: label.trim(), filePath });
      res.status(201).json({ success: true, data: doc });
    } catch (err) {
      console.error('[AdditionalDocsMeCtrl.save] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async remove(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
      const { id } = req.params;
      const worker = await this.resolveWorker(authUid);
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }
      // Fetch doc to delete from GCS
      const docs = await this.repo.findByWorkerId(worker.id);
      const target = docs.find(d => d.id === id);
      // Hotfix 13/09 (rodada 2, R3): caminho legado fora do prefixo do
      // worker não vai ao GCS, mas o registro é apagado do mesmo jeito —
      // já localizado pelo dono (worker autenticado).
      if (target) {
        if (matchesOwnedDocumentPrefix(target.filePath, this.gcs.getBucketName(), worker.id)) {
          await this.gcs.deleteFile(target.filePath, worker.id);
        } else {
          console.warn('[AdditionalDocsMeCtrl.remove] legacy path fora do prefixo — record_only | actorUid:', authUid, '| workerId:', worker.id, '| additionalDocId:', id, '| result: record_only');
        }
      }
      await this.repo.deleteById(id, worker.id);
      res.status(200).json({ success: true });
    } catch (err) {
      if (err instanceof DocumentPathOwnershipError) {
        console.warn('[AdditionalDocsMeCtrl.remove] DENY (2ª camada, GCSStorageService) | result: path not owned');
        res.status(404).json({ success: false, error: 'Document not found' }); return;
      }
      console.error('[AdditionalDocsMeCtrl.remove] ERROR:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
