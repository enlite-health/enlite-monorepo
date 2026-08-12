import { IWorkerTagRepository } from '../ports/IWorkerTagRepository';
import { WorkerTag, UpdateWorkerTagDTO } from '../domain/WorkerTag';

export class UpdateTagUseCase {
  constructor(private readonly repo: IWorkerTagRepository) {}

  async execute(id: string, input: UpdateWorkerTagDTO): Promise<WorkerTag | null> {
    return this.repo.updateTag(id, input);
  }
}
