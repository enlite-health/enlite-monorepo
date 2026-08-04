import { z } from 'zod';
import type { ListInterviewSlotsForVacancyUseCase } from '../../../matching/application/ListInterviewSlotsForVacancyUseCase';
import type { ListInterviewSlotsResult } from '../../../matching/application/ListInterviewSlotsForVacancyUseCase';

const ArgsShape = {
  jobPostingId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerInterviewSlotsListCapability (worker.interview.slots.list) — READ.
 *
 * Horários de entrevista da vaga, SÓ futuros (lição PR #177), com label legível
 * (mesma formatação do convite por botão) + iso. Meet links NUNCA saem daqui —
 * a Luz comunica horários, o servidor resolve o link no book.
 */
export class WorkerInterviewSlotsListCapability {
  static readonly NAME = 'worker.interview.slots.list';
  static readonly DESCRIPTION =
    'List FUTURE interview slots of a vacancy: {slots:[{index,label,iso}], caseNumber}. Labels are es-AR human-readable (e.g. "Lun 07/04 10:00"). Meet links are never returned.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: ListInterviewSlotsForVacancyUseCase) {}

  async execute(args: unknown): Promise<ListInterviewSlotsResult> {
    const { jobPostingId } = ArgsSchema.parse(args);
    return this.useCase.execute(jobPostingId);
  }
}
