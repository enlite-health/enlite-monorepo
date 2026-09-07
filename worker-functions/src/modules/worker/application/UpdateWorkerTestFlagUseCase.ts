import { IWorkerRepository } from '../ports/IWorkerRepository';

/**
 * Marks/unmarks a worker as a test account.
 *
 * Returns the resulting flag value, or null when no worker with that id exists.
 * Authorization (`worker:write`) is enforced at the route layer (PermissionMiddleware).
 */
export class UpdateWorkerTestFlagUseCase {
  constructor(private readonly workerRepository: IWorkerRepository) {}

  async execute(workerId: string, isTest: boolean): Promise<boolean | null> {
    return this.workerRepository.updateTestFlag(workerId, isTest);
  }
}
