/**
 * RecordBlockedAttemptUseCase.test.ts
 *
 * Cenários:
 * 1. Sucesso — delega para repo.upsert com os params corretos
 * 2. Falha no repo — loga warn e NÃO propaga exceção (fire-and-forget)
 * 3. Falha com objeto não-Error — também não propaga
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

  it('delega para repo.upsert com todos os params', async () => {
    mockUpsert.mockResolvedValueOnce(undefined);

    await useCase.execute({
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
  });

  it('não propaga erro quando repo.upsert falha — loga warn', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('DB explodiu'));

    await expect(
      useCase.execute({
        workerId: WORKER_ID,
        jobPostingId: JOB_ID,
        reason: 'worker_disabled',
        acquisitionChannel: null,
      }),
    ).resolves.toBeUndefined();

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

  it('não propaga erro quando repo.upsert lança objeto não-Error', async () => {
    mockUpsert.mockRejectedValueOnce('string error');

    await expect(
      useCase.execute({
        workerId: WORKER_ID,
        jobPostingId: JOB_ID,
        reason: 'worker_not_found',
        acquisitionChannel: null,
      }),
    ).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'string error' }),
    );
  });

  it('passa acquisitionChannel=null corretamente', async () => {
    mockUpsert.mockResolvedValueOnce(undefined);

    await useCase.execute({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'worker_not_found',
      acquisitionChannel: null,
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ acquisitionChannel: null }),
    );
  });
});
