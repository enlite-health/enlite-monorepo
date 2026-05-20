import { WorkerDocumentsListCapability } from '../WorkerDocumentsListCapability';
import type { IWorkerDocumentsRepository } from '../../../../worker/infrastructure/WorkerDocumentsRepository';
import type { WorkerDocuments } from '../../../../worker/domain/WorkerDocuments';

const VALID_ARGS = { workerId: '123e4567-e89b-12d3-a456-426614174000' };

function makeRepo(
  result?: WorkerDocuments | null,
  throws?: Error,
): jest.Mocked<Pick<IWorkerDocumentsRepository, 'findByWorkerId'>> {
  return {
    findByWorkerId: throws
      ? jest.fn().mockRejectedValue(throws)
      : jest.fn().mockResolvedValue(result ?? null),
  };
}

describe('WorkerDocumentsListCapability', () => {
  it('NAME is worker.documents.list', () => {
    expect(WorkerDocumentsListCapability.NAME).toBe('worker.documents.list');
  });

  it('DESCRIPTION is a non-empty string', () => {
    expect(typeof WorkerDocumentsListCapability.DESCRIPTION).toBe('string');
    expect(WorkerDocumentsListCapability.DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('INPUT_SHAPE has workerId field', () => {
    expect(WorkerDocumentsListCapability.INPUT_SHAPE).toHaveProperty('workerId');
  });

  // success — documents found
  it('success: returns WorkerDocuments when found', async () => {
    const docs = { id: 'doc-1', workerId: VALID_ARGS.workerId } as WorkerDocuments;
    const repo = makeRepo(docs);
    const cap = new WorkerDocumentsListCapability(repo as unknown as IWorkerDocumentsRepository);

    const result = await cap.execute(VALID_ARGS);

    expect(repo.findByWorkerId).toHaveBeenCalledWith(VALID_ARGS.workerId);
    expect(result).toBe(docs);
  });

  // success — no documents (null)
  it('success: returns null when no documents exist', async () => {
    const repo = makeRepo(null);
    const cap = new WorkerDocumentsListCapability(repo as unknown as IWorkerDocumentsRepository);

    const result = await cap.execute(VALID_ARGS);
    expect(result).toBeNull();
  });

  // repo throws
  it('propagates error from repo', async () => {
    const err = new Error('DB connection failed');
    const repo = makeRepo(undefined, err);
    const cap = new WorkerDocumentsListCapability(repo as unknown as IWorkerDocumentsRepository);

    await expect(cap.execute(VALID_ARGS)).rejects.toThrow('DB connection failed');
  });

  // Zod validation
  it('throws ZodError for invalid workerId', async () => {
    const repo = makeRepo();
    const cap = new WorkerDocumentsListCapability(repo as unknown as IWorkerDocumentsRepository);

    await expect(cap.execute({ workerId: 'bad' })).rejects.toThrow();
    expect(repo.findByWorkerId).not.toHaveBeenCalled();
  });

  it('throws ZodError when workerId is missing', async () => {
    const repo = makeRepo();
    const cap = new WorkerDocumentsListCapability(repo as unknown as IWorkerDocumentsRepository);

    await expect(cap.execute({})).rejects.toThrow();
  });
});
