import { IWorkerTagRepository } from '../ports/IWorkerTagRepository';

export class AssignTagToWorkerUseCase {
  constructor(private readonly repo: IWorkerTagRepository) {}

  /**
   * Associa tag a worker.
   *
   * Valida que a tag existe e não foi soft-deletada antes de inserir —
   * lança erro de domínio se a tag for inválida/deletada.
   *
   * A inserção é idempotente (ON CONFLICT DO NOTHING no repo).
   */
  async execute(workerId: string, tagId: string, assignedBy: string): Promise<void> {
    const tag = await this.repo.findTagById(tagId);

    if (!tag) {
      throw new Error(`Tag not found: ${tagId}`);
    }

    // findTagById retorna tags inclusive soft-deletadas; precisamos checar o repo diretamente
    // O repo.assignTagToWorker já faz a verificação de deleted_at e retorna false se deletada.
    const assigned = await this.repo.assignTagToWorker(workerId, tagId, assignedBy);

    if (!assigned) {
      throw new Error(`Tag is deleted or does not exist: ${tagId}`);
    }
  }
}
