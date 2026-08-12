import { Request, Response } from 'express';
import { z } from 'zod';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { UpdateWorkerTestFlagUseCase } from '../../application/UpdateWorkerTestFlagUseCase';
import { WorkerAuditRepository, extractWorkerAuditActor } from '../../infrastructure/WorkerAuditRepository';
import { logger, reportError } from '@shared/logging';

/**
 * AdminWorkerTestFlagController
 *
 * Marca/desmarca um worker como conta de teste.
 *
 * Rota (registrada em src/index.ts, adminOnly — role === ADMIN):
 *   PATCH /api/admin/workers/:id/test-flag   body: { isTest: boolean }
 */

const TestFlagBodySchema = z.object({
  isTest: z.boolean(),
});

function getUid(req: Request): string | null {
  return (req as Request & { user?: { uid: string } }).user?.uid ?? null;
}

export class AdminWorkerTestFlagController {
  private readonly useCase: UpdateWorkerTestFlagUseCase;
  private readonly auditRepo: WorkerAuditRepository;

  constructor() {
    this.useCase = new UpdateWorkerTestFlagUseCase(new WorkerRepository());
    this.auditRepo = new WorkerAuditRepository();
  }

  /** PATCH /api/admin/workers/:id/test-flag */
  async updateTestFlag(req: Request, res: Response): Promise<void> {
    const uid = getUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { id } = req.params;
    const parsed = TestFlagBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    try {
      const isTest = await this.useCase.execute(id, parsed.data.isTest);
      if (isTest === null) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }
      logger.info({ msg: 'worker test-flag updated', workerId: id, isTest, uid });
      await this.auditRepo.recordFieldChanges({
        workerId: id,
        fields: [{ field: 'isTest', before: null, after: isTest }],
        actor: extractWorkerAuditActor(req),
      });
      res.status(200).json({ success: true, data: { isTest } });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminWorkerTestFlagController:updateTestFlag', workerId: id, uid });
      res.status(500).json({ success: false, error: 'Failed to update test flag' });
    }
  }
}
