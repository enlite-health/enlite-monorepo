import { Pool } from 'pg';
import { IMessagingService } from '../domain/IMessagingService';
import {
  BulkDispatchIncompleteWorkersUseCase,
  BulkDispatchOptions,
  BulkDispatchResult,
} from '../application/BulkDispatchIncompleteWorkersUseCase';
import { logger } from '@shared/logging';

/**
 * BulkDispatchScheduler — dispara bulk dispatch de workers incompletos.
 *
 * Método stateless `run()` chamado via Cloud Scheduler (diário 10h BRT)
 * através do endpoint POST /api/internal/bulk-dispatch/process.
 */
export class BulkDispatchScheduler {
  constructor(
    private readonly db: Pool,
    private readonly messaging: IMessagingService,
  ) {}

  /** Executa o bulk dispatch. Stateless — chamado via Cloud Scheduler. */
  async run(options: BulkDispatchOptions = {}): Promise<BulkDispatchResult> {
    logger.info({ dryRun: options.dryRun, limit: options.limit }, 'BulkDispatchScheduler iniciando');

    const useCase = new BulkDispatchIncompleteWorkersUseCase(this.db, this.messaging);
    const result = await useCase.execute('scheduler', options);

    if (result.isFailure) {
      logger.error({ error: result.error }, 'BulkDispatchScheduler falhou');
      throw new Error(result.error);
    }

    return result.getValue()!;
  }
}
