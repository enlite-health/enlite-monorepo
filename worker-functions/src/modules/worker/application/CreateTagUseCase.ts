import { IWorkerTagRepository } from '../ports/IWorkerTagRepository';
import { WorkerTag, CreateWorkerTagDTO } from '../domain/WorkerTag';

export class CreateTagUseCase {
  constructor(private readonly repo: IWorkerTagRepository) {}

  async execute(input: CreateWorkerTagDTO): Promise<WorkerTag> {
    return this.repo.createTag(input);
  }
}
