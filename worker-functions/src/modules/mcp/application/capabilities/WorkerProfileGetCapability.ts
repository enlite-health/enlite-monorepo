import { z } from 'zod';
import type { GetWorkerByIdUseCase, GetWorkerByIdResult } from '../../../worker/application/GetWorkerByIdUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerProfileGetCapability
 *
 * Returns worker profile by UUID. Exposes name, status, and registration
 * progress so the triage service can describe the worker to the LLM context.
 */
export class WorkerProfileGetCapability {
  static readonly NAME = 'worker.profile.get';
  static readonly DESCRIPTION =
    'Get worker profile by ID. Returns name, status, and registration progress.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: GetWorkerByIdUseCase) {}

  async execute(args: unknown): Promise<GetWorkerByIdResult> {
    const parsed = ArgsSchema.parse(args);
    return this.useCase.execute(parsed.workerId);
  }
}
