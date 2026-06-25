/**
 * RecordBlockedAttemptUseCase.test.ts
 *
 * Cenários:
 * 1. Sucesso — delega para repo.upsert com os params corretos e retorna missingFields
 * 2. Falha no repo — loga warn, NÃO propaga, retorna []
 * 3. Falha com objeto não-Error — também não propaga, retorna []
 * 4. Retorna missingFields expandidos do repo
 */

const mockUpsert = jest.fn();

jest.mock('../../infrastructure/BlockedApplicationRepository', () => ({
  BlockedApplicationRepository: jest.fn().mockImplementation(() => ({
    upsert: mockUpsert,
  })),
}));

const mockLoggerWarn = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn() }),
    warn: mockLoggerWarn,
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import { RecordBlockedAttemptUseCase } from '../RecordBlockedAttemptUseCase';

const WORKER_ID = 'aaaa0000-0000-0000-0000-111111111111';
const JOB_ID    = 'bbbb0000-0000-0000-0000-222222222222';

describe('RecordBlockedAttemptUseCase', () => {
  let useCase: RecordBlockedAttemptUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new RecordBlockedAttemptUseCase();
  });

  it('delega para repo.upsert com todos os params e retorna missingFields', async () => {
    mockUpsert.mockResolvedValueOnce(['first_name', 'phone']);

    const result = await useCase.execute({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: 'facebook',
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: 'facebook',
    });
    expect(result).toEqual(['first_name', 'phone']);
  });

  it('retorna missingFields expandidos (doc_* tokens) do repo', async () => {
    mockUpsert.mockResolvedValueOnce(['doc_identity_document', 'doc_at_certificate']);

    const result = await useCase.execute({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    expect(result).toEqual(['doc_identity_document', 'doc_at_certificate']);
  });

  it('não propaga erro quando repo.upsert falha — loga warn, retorna []', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('DB explodiu'));

    const result = await useCase.execute({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'worker_disabled',
      acquisitionChannel: null,
    });

    expect(result).toEqual([]);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('failed to record blocked attempt'),
        workerId: WORKER_ID,
        jobPostingId: JOB_ID,
        reason: 'worker_disabled',
        error: 'DB explodiu',
      }),
    );
  });

  it('não propaga erro quando repo.upsert lança objeto não-Error — retorna []', async () => {
    mockUpsert.mockRejectedValueOnce('string error');

    const result = await useCase.execute({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'worker_not_found',
      acquisitionChannel: null,
    });

    expect(result).toEqual([]);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'string error' }),
    );
  });

  it('passa acquisitionChannel=null corretamente', async () => {
    mockUpsert.mockResolvedValueOnce([]);

    const result = await useCase.execute({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'worker_not_found',
      acquisitionChannel: null,
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ acquisitionChannel: null }),
    );
    expect(result).toEqual([]);
  });
});
