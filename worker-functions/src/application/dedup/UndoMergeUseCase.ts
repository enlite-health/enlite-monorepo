/**
 * UndoMergeUseCase
 *
 * Desfaz um merge a partir do auditId.
 * Delega para WorkerPhoneMergeService.undoMerge().
 * Idempotente: se já desfeito, retorna alreadyUndone=true.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { WorkerPhoneMergeService } from '../../infrastructure/services/WorkerPhoneMergeService';

const log = logger.child({ source: 'UndoMergeUseCase' });

export interface UndoMergeResult {
  auditId: number;
  survivorId: string;
  absorbedId: string;
  alreadyUndone: boolean;
}

export class UndoMergeUseCase {
  private readonly mergeService: WorkerPhoneMergeService;

  constructor(_pool: Pool) {
    this.mergeService = new WorkerPhoneMergeService();
  }

  async execute(auditId: number): Promise<UndoMergeResult> {
    log.info({ msg: 'undo_merge_start', auditId });

    const result = await this.mergeService.undoMerge(auditId);

    log.info({
      msg: 'undo_merge_done',
      auditId,
      survivorId: result.survivorId,
      absorbedId: result.absorbedId,
      alreadyUndone: result.alreadyUndone,
    });

    return {
      auditId,
      survivorId: result.survivorId,
      absorbedId: result.absorbedId,
      alreadyUndone: result.alreadyUndone,
    };
  }
}
