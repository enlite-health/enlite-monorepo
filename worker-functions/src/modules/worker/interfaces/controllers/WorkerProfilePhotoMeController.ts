import { Request, Response } from 'express';
import { selfUid } from '@shared/http/selfUid';
import { logger, safeErrorFields } from '@shared/logging';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { ClearProfilePhotoUseCase } from '../../application/ClearProfilePhotoUseCase';
import { IWorkerRepository } from '../../ports/IWorkerRepository';

/** DELETE /api/workers/me/photo — a prestadora apaga a PRÓPRIA foto (D815). Identidade só pelo token. */
export class WorkerProfilePhotoMeController {
  private readonly workerRepo: IWorkerRepository;
  private readonly clearUseCase: ClearProfilePhotoUseCase;

  constructor(workerRepo: IWorkerRepository = new WorkerRepository()) {
    this.workerRepo = workerRepo;
    this.clearUseCase = new ClearProfilePhotoUseCase(workerRepo);
  }

  async remove(req: Request, res: Response): Promise<void> {
    try {
      const authUid = selfUid(req);
      if (!authUid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

      // findByAuthUid segue merged_into_id: SELECT direto por auth_uid devolveria o casco absorvido.
      const found = await this.workerRepo.findByAuthUid(authUid);
      const worker = found.isFailure ? null : found.getValue();
      if (!worker) { res.status(404).json({ success: false, error: 'Worker not found' }); return; }

      const result = await this.clearUseCase.execute(worker.id);
      if (result.isFailure) {
        logger.child({ workerId: worker.id }).error({ msg: '[WorkerProfilePhotoMe] clear failed' });
        res.status(500).json({ success: false, error: 'Internal server error' });
        return;
      }
      res.status(200).json({ success: true, data: { message: 'Profile photo removed' } });
    } catch (error: unknown) {
      logger.error(safeErrorFields(error), 'WorkerProfilePhotoMe remove error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
