import { z } from 'zod';
import type {
  ListAvailableVacanciesForWorkerUseCase,
  ListAvailableVacanciesResult,
} from '../../../matching/application/ListAvailableVacanciesForWorkerUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerVacanciesListCapability
 *
 * Lists available vacancies (active funnel stages) for a given worker.
 * Returns vacancy ID, title, status, city, start date, and funnel stage.
 */
export class WorkerVacanciesListCapability {
  static readonly NAME = 'worker.vacancies.list';
  static readonly DESCRIPTION =
    'List available vacancies for a worker. Returns active funnel entries with vacancy details.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: ListAvailableVacanciesForWorkerUseCase) {}

  async execute(args: unknown): Promise<ListAvailableVacanciesResult> {
    const parsed = ArgsSchema.parse(args);
    return this.useCase.execute(parsed.workerId);
  }
}
