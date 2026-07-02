import { z } from 'zod';
import type {
  GetWorkerStatsUseCase,
  WorkerStatsResult,
} from '../../../worker/application/GetWorkerStatsUseCase';

const ArgsShape = {};
const ArgsSchema = z.object(ArgsShape).strip();

export class WorkerStatsGetCapability {
  static readonly NAME = 'worker.stats.get';
  static readonly DESCRIPTION =
    'Aggregate worker statistics: total registered workers, counts by status, ' +
    'applications by funnel stage, and recent registrations. Takes no arguments. ' +
    'Use this for questions like "how many workers are registered?".';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: GetWorkerStatsUseCase) {}

  async execute(args: unknown): Promise<WorkerStatsResult> {
    ArgsSchema.parse(args ?? {});
    return this.useCase.execute();
  }
}
