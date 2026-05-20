import type { IWorkerRepository } from '../ports/IWorkerRepository';
import type { Worker } from '../domain/Worker';
import { logger } from '@shared/logging';

export interface GetWorkerByIdResult {
  worker: Worker;
}

/**
 * GetWorkerByIdUseCase
 *
 * Retorna o perfil de um worker pelo seu UUID de banco (id).
 * Usado pelo MCP server: o triage-service conhece o workerId (UUID), não o authUid.
 */
export class GetWorkerByIdUseCase {
  constructor(private readonly workerRepository: IWorkerRepository) {}

  async execute(workerId: string): Promise<GetWorkerByIdResult> {
    const log = logger.child({ workerId, useCase: 'GetWorkerByIdUseCase' });
    log.info({ msg: 'fetching worker by id' });

    const result = await this.workerRepository.findById(workerId);

    if (result.isFailure) {
      throw new Error(result.error ?? 'Failed to fetch worker');
    }

    const worker = result.getValue();
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }

    return { worker };
  }
}
