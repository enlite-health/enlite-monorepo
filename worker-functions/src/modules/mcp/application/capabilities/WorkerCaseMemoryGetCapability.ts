import { z } from 'zod';
import type { CaseMemoryRepository } from '../../../worker/infrastructure/CaseMemoryRepository';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerCaseMemoryGetCapability (worker.caseMemory.get)
 *
 * Lê o dossiê da Luz (Camada A) — memória do relacionamento com o worker. O
 * triage injeta isso no prompt pra a Luz retomar o caso sem repetir.
 */
export class WorkerCaseMemoryGetCapability {
  static readonly NAME = 'worker.caseMemory.get';
  static readonly DESCRIPTION =
    'Get the Luz case-memory (relationship dossier: stage, missing, tried, blocker, lastPromise) for a worker.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: CaseMemoryRepository) {}

  async execute(
    args: unknown,
  ): Promise<
    { found: false } | { found: true; caseMemory: Record<string, unknown> }
  > {
    const { workerId } = ArgsSchema.parse(args);
    const rec = await this.repo.get(workerId);
    if (!rec) return { found: false };
    return {
      found: true,
      caseMemory: { ...rec.caseMemory, updatedAt: rec.updatedAt },
    };
  }
}
