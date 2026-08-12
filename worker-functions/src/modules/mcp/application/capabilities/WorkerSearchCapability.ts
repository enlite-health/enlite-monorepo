import { z } from 'zod';
import type {
  SearchWorkersUseCase,
  SearchWorkersResult,
} from '../../../worker/application/SearchWorkersUseCase';

const ArgsShape = {
  search: z
    .string()
    .min(3)
    .optional()
    .describe('Email, phone digits, or name (min 3 chars) to search for'),
  status: z
    .string()
    .optional()
    .describe('Filter by worker status, e.g. REGISTERED or INCOMPLETE_REGISTER'),
  profession: z
    .string()
    .optional()
    .describe('CSV of professions: AT, CAREGIVER, NURSE, KINESIOLOGIST, PSYCHOLOGIST'),
  sex: z.string().optional(),
  language: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional().describe('Page size (default 20, max 50)'),
  offset: z.number().int().min(0).optional(),
};
const ArgsSchema = z.object(ArgsShape);

export class WorkerSearchCapability {
  static readonly NAME = 'worker.search';
  static readonly DESCRIPTION =
    'Search/list workers with filters and pagination. Returns id, name, email, status and ' +
    'document status per worker — use worker.profile.get for full details of one worker. ' +
    'Call without filters to list the most recent workers.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: SearchWorkersUseCase) {}

  async execute(args: unknown): Promise<SearchWorkersResult> {
    const parsed = ArgsSchema.parse(args ?? {});
    return this.useCase.execute({
      ...parsed,
      limit: parsed.limit ?? 20,
      offset: parsed.offset ?? 0,
    });
  }
}
