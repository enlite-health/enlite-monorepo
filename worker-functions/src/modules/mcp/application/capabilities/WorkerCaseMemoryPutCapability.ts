import { z } from 'zod';
import type { CaseMemoryRepository } from '../../../worker/infrastructure/CaseMemoryRepository';

const ArgsShape = {
  workerId: z.string().uuid(),
  stage: z.string().optional(),
  missing: z.array(z.string()).optional(),
  blocker: z.string().optional(),
  lastPromise: z.string().optional(),
  note: z.string().optional(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerCaseMemoryPutCapability (worker.caseMemory.put) — WRITE.
 *
 * MERGE parcial do dossiê da Luz: só os campos enviados são tocados; `note` é
 * acrescentado a `tried`. O servidor aplica FIFO/caps/validação de stage
 * (applyCaseMemoryPatch) — a IA não é fonte de verdade da forma.
 */
export class WorkerCaseMemoryPutCapability {
  static readonly NAME = 'worker.caseMemory.put';
  static readonly DESCRIPTION =
    'Merge-update the Luz case-memory for a worker (partial: only sent fields change; note is appended to tried; server applies FIFO/caps).';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: CaseMemoryRepository) {}

  async execute(args: unknown): Promise<{ ok: true }> {
    const { workerId, ...patch } = ArgsSchema.parse(args);
    await this.repo.put(workerId, patch);
    return { ok: true };
  }
}
