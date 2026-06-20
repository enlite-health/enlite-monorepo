import { IWorkerTagRepository } from '../ports/IWorkerTagRepository';

export class RemoveTagFromWorkerUseCase {
  constructor(private readonly repo: IWorkerTagRepository) {}

  /** Remove associação worker ↔ tag. Retorna true se havia associação. */
  async execute(workerId: string, tagId: string): Promise<boolean> {
    return this.repo.removeTagFromWorker(workerId, tagId);
  }
}
