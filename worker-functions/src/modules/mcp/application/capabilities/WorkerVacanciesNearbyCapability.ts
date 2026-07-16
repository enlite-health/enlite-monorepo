import { z } from 'zod';
import type { FindNearbyVacanciesForWorkerUseCase } from '../../../matching/application/FindNearbyVacanciesForWorkerUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerVacanciesNearbyCapability (worker.vacancies.nearby) — READ.
 *
 * Vagas ativas que o worker QUASE cobre (faltam poucos dias da disponibilidade dele).
 * A Luz mostra como "oportunidades cerca de tus días" e pode oferecer adaptar. Devolve
 * caso + zona + schedule + os dias que faltam. De-identificado (sem paciente/monto).
 */
export class WorkerVacanciesNearbyCapability {
  static readonly NAME = 'worker.vacancies.nearby';
  static readonly DESCRIPTION =
    'List active vacancies the worker NEARLY matches (missing a few availability days). Returns case, zone, schedule and the missing days. De-identified.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: FindNearbyVacanciesForWorkerUseCase) {}

  async execute(args: unknown): Promise<unknown> {
    const { workerId } = ArgsSchema.parse(args);
    return this.useCase.execute(workerId);
  }
}
