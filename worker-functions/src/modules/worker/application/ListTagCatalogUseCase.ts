import { IWorkerTagRepository } from '../ports/IWorkerTagRepository';
import { WorkerTag } from '../domain/WorkerTag';

export class ListTagCatalogUseCase {
  constructor(private readonly repo: IWorkerTagRepository) {}

  async execute(): Promise<WorkerTag[]> {
    return this.repo.listCatalog();
  }
}
