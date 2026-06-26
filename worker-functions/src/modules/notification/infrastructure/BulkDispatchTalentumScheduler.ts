import { Pool } from 'pg';
import { IMessagingService } from '../domain/IMessagingService';
import { BulkDispatchTalentumIncompleteUseCase, BulkDispatchTalentumResult } from '../application/BulkDispatchTalentumIncompleteUseCase';

/**
 * BulkDispatchTalentumScheduler — dispara bulk dispatch de workers com Talentum incompleto.
 *
 * Método stateless `run()` chamado via Cloud Scheduler (diário)
 * através do endpoint POST /api/internal/bulk-dispatch/talentum-incomplete.
 *
 * Critério: application_funnel_stage IN ('PRE_SCREENING', 'IN_PROGRESS') há >5 dias,
 * (Migration 230: INITIATED renomeado para PRE_SCREENING)
 * sem reminder enviado nos últimos 7 dias.
 */
export class BulkDispatchTalentumScheduler {
  private readonly useCase: BulkDispatchTalentumIncompleteUseCase;

  constructor(db: Pool, messaging: IMessagingService) {
    this.useCase = new BulkDispatchTalentumIncompleteUseCase(db, messaging);
  }

  /** Executa o bulk dispatch Talentum. Stateless — chamado via Cloud Scheduler. */
  async run(): Promise<BulkDispatchTalentumResult> {
    return this.useCase.execute('scheduler');
  }
}
