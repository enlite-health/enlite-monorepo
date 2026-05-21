import { z } from 'zod';
import type { IWorkerDocumentsRepository } from '../../../worker/infrastructure/WorkerDocumentsRepository';
import type { WorkerDocuments } from '../../../worker/domain/WorkerDocuments';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerDocumentsListCapability
 *
 * Returns the document submission record for a worker: URLs, status,
 * validations, and review notes. Returns null if no documents record exists.
 */
export class WorkerDocumentsListCapability {
  static readonly NAME = 'worker.documents.list';
  static readonly DESCRIPTION =
    'List worker documents by worker ID. Returns document URLs, status, and validations.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: IWorkerDocumentsRepository) {}

  async execute(args: unknown): Promise<WorkerDocuments | null> {
    const parsed = ArgsSchema.parse(args);
    return this.repo.findByWorkerId(parsed.workerId);
  }
}
