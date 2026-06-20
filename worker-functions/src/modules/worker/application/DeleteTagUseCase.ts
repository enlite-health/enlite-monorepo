import { IWorkerTagRepository } from '../ports/IWorkerTagRepository';

export class DeleteTagUseCase {
  constructor(private readonly repo: IWorkerTagRepository) {}

  /** Soft-delete. Returns true if the tag was found and deleted. */
  async execute(id: string): Promise<boolean> {
    return this.repo.softDeleteTag(id);
  }
}
