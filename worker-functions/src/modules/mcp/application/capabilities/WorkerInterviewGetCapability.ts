import { z } from 'zod';
import type {
  GetCurrentInterviewUseCase,
  GetCurrentInterviewResult,
} from '../../../matching/application/GetCurrentInterviewUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerInterviewGetCapability
 *
 * Returns the next scheduled interview for a worker, or null if none exists.
 * Includes vacancy title, scheduled datetime, Meet link, and status.
 */
export class WorkerInterviewGetCapability {
  static readonly NAME = 'worker.interview.get';
  static readonly DESCRIPTION =
    'Get the next scheduled interview for a worker. Returns vacancy title, datetime, and Meet link, or null if no upcoming interview exists.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: GetCurrentInterviewUseCase) {}

  async execute(args: unknown): Promise<GetCurrentInterviewResult> {
    const parsed = ArgsSchema.parse(args);
    return this.useCase.execute(parsed.workerId);
  }
}
