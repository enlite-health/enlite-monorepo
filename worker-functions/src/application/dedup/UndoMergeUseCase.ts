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
import type { UndoAuditContext } from './DedupTypes';
import { resolveAdminEmail } from './resolveAdminEmail';

const log = logger.child({ source: 'UndoMergeUseCase' });

export interface UndoMergeResult {
  auditId: number;
  survivorId: string;
  absorbedId: string;
  alreadyUndone: boolean;
}

export class UndoMergeUseCase {
  private readonly mergeService: WorkerPhoneMergeService;

  constructor(private readonly pool: Pool) {
    this.mergeService = new WorkerPhoneMergeService();
  }

  async execute(auditId: number, undoAudit?: UndoAuditContext): Promise<UndoMergeResult> {
    // Resolve o email do admin que está desfazendo, pra registro legível.
    const undoneByEmail: string | undefined =
      undoAudit?.undoneByEmail ?? (await resolveAdminEmail(this.pool, undoAudit?.undoneBy)) ?? undefined;
    const ctx: UndoAuditContext = { ...undoAudit, undoneByEmail };

    log.info({
      msg: 'undo_merge_start',
      auditId,
      undone_by: ctx.undoneBy ?? 'system',
      undone_by_email: undoneByEmail,
      ip_address: ctx.ipAddress ?? null,
      request_id: ctx.requestId ?? null,
    });

    const result = await this.mergeService.undoMerge(auditId, ctx);

    log.info({
      msg: 'undo_merge_done',
      auditId,
      survivorId: result.survivorId,
      absorbedId: result.absorbedId,
      alreadyUndone: result.alreadyUndone,
      undone_by: ctx.undoneBy ?? 'system',
      undone_by_email: undoneByEmail,
    });

    return {
      auditId,
      survivorId: result.survivorId,
      absorbedId: result.absorbedId,
      alreadyUndone: result.alreadyUndone,
    };
  }
}
