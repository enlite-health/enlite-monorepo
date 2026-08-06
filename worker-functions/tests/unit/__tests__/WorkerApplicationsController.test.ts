/**
 * WorkerApplicationsController — Unit Tests
 *
 * Cobre branches NÃO presentes no co-located test
 * (src/modules/matching/interfaces/controllers/__tests__/WorkerApplicationsController.test.ts):
 *
 *   - 403 quando WorkerNotEligibleError com todos os reason values
 *   - recordBlockedAttemptUseCase.execute chamado com params corretos
 *   - 403 emitido mesmo se o record falha (fire-and-forget)
 *   - resolveWorker: name='' quando firstName/lastName undefined (branch `|| ''`)
 *   - resolveWorker: phone='' quando phone undefined (branch `|| ''`)
 *   - 500 com "Unknown error" quando erro não-Error lança (branch ternário)
 */

// ── Mocks (hoist antes dos imports) ──────────────────────────────────

const mockGetProgressExecute = jest.fn();
const mockRecordExecute = jest.fn();
const mockDbQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({
      getPool: () => (require('@shared/database/poolMockSupport') as typeof import('@shared/database/poolMockSupport')).poolMockWithConnect(mockDbQuery),
    }),
  },
}));

jest.mock('@modules/worker', () => ({
  GetWorkerProgressUseCase: jest.fn().mockImplementation(() => ({
    execute: mockGetProgressExecute,
  })),
  WorkerRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock(
  '../../../src/modules/matching/application/RecordBlockedAttemptUseCase',
  () => ({
    RecordBlockedAttemptUseCase: jest.fn().mockImplementation(() => ({
      execute: mockRecordExecute,
    })),
  }),
);

jest.mock('@shared/logging', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    child: jest.fn().mockReturnValue({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
  },
  reportError: jest.fn(),
}));

import { WorkerNotEligibleError } from '../../../src/modules/matching/domain/WorkerApplicationEligibility';

jest.mock(
  '../../../src/modules/matching/domain/WorkerApplicationEligibility',
  () => {
    const actual = jest.requireActual(
      '../../../src/modules/matching/domain/WorkerApplicationEligibility',
    ) as typeof import('../../../src/modules/matching/domain/WorkerApplicationEligibility');
    return { ...actual, assertWorkerCanApply: jest.fn() };
  },
);

import { WorkerApplicationsController } from '../../../src/modules/matching/interfaces/controllers/WorkerApplicationsController';
import { assertWorkerCanApply } from '../../../src/modules/matching/domain/WorkerApplicationEligibility';

const mockAssertWorkerCanApply = assertWorkerCanApply as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────

const WORKER_ID      = 'worker-uuid-aaa';
const JOB_POSTING_ID = 'job-uuid-bbb';

function mockReq(
  overrides: {
    body?: Record<string, unknown>;
    uid?: string | null;
    headers?: Record<string, string>;
  } = {},
): unknown {
  const uid = overrides.uid !== undefined ? overrides.uid : 'firebase-uid-001';
  return {
    body: overrides.body ?? { jobPostingId: JOB_POSTING_ID, channel: 'facebook' },
    headers: overrides.headers ?? (uid ? { 'x-auth-uid': uid } : {}),
    user: uid ? { uid } : undefined,
  };
}

function mockRes(): { status: jest.Mock; json: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function mockWorkerFound(overrides: Partial<{ id: string; firstName: string; lastName: string; phone: string }> = {}): void {
  mockGetProgressExecute.mockResolvedValueOnce({
    isFailure: false,
    getValue: () => ({
      id: overrides.id ?? WORKER_ID,
      firstName: overrides.firstName,
      lastName: overrides.lastName,
      phone: overrides.phone,
    }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('WorkerApplicationsController.trackChannel — branches adicionais', () => {
  let controller: WorkerApplicationsController;

  beforeEach(() => {
    mockGetProgressExecute.mockReset();
    mockRecordExecute.mockReset();
    mockDbQuery.mockReset();
    mockAssertWorkerCanApply.mockReset();
    controller = new WorkerApplicationsController();
  });

  // ── 403 WorkerNotEligibleError — branch principal da feature ──────

  describe('403 WorkerNotEligibleError', () => {
    it('reason=registration_incomplete: chama record com params corretos', async () => {
      mockWorkerFound({ id: WORKER_ID, firstName: 'João', lastName: 'Silva', phone: '+55' });
      mockAssertWorkerCanApply.mockRejectedValueOnce(
        new WorkerNotEligibleError(WORKER_ID, 'registration_incomplete', 'INCOMPLETE_REGISTER'),
      );
      mockRecordExecute.mockResolvedValueOnce(undefined);

      const req = mockReq();
      const res = mockRes();
      await controller.trackChannel(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'WORKER_NOT_ELIGIBLE', reason: 'registration_incomplete' }),
      );
      expect(mockRecordExecute).toHaveBeenCalledWith({
        workerId: WORKER_ID,
        jobPostingId: JOB_POSTING_ID,
        reason: 'registration_incomplete',
        acquisitionChannel: 'facebook',
      });
    });

    it('reason=worker_disabled: record chamado, 403 emitido', async () => {
      mockWorkerFound({ id: WORKER_ID });
      mockAssertWorkerCanApply.mockRejectedValueOnce(
        new WorkerNotEligibleError(WORKER_ID, 'worker_disabled', 'DISABLED'),
      );
      mockRecordExecute.mockResolvedValueOnce(undefined);

      const req = mockReq({ body: { jobPostingId: JOB_POSTING_ID, channel: 'instagram' } });
      const res = mockRes();
      await controller.trackChannel(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockRecordExecute).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'worker_disabled', acquisitionChannel: 'instagram' }),
      );
    });

    it('reason=worker_not_found: record chamado', async () => {
      mockWorkerFound({ id: WORKER_ID });
      mockAssertWorkerCanApply.mockRejectedValueOnce(
        new WorkerNotEligibleError(WORKER_ID, 'worker_not_found', null),
      );
      mockRecordExecute.mockResolvedValueOnce(undefined);

      const req = mockReq({ body: { jobPostingId: JOB_POSTING_ID, channel: 'linkedin' } });
      const res = mockRes();
      await controller.trackChannel(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockRecordExecute).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'worker_not_found' }),
      );
    });

    it('403 emitido mesmo se recordBlockedAttemptUseCase.execute resolver (fire-and-forget ok)', async () => {
      mockWorkerFound();
      mockAssertWorkerCanApply.mockRejectedValueOnce(
        new WorkerNotEligibleError(WORKER_ID, 'registration_incomplete', 'INCOMPLETE_REGISTER'),
      );
      mockRecordExecute.mockResolvedValueOnce(undefined);

      const res = mockRes();
      await controller.trackChannel(mockReq() as never, res as never);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('todos os canais válidos passam como acquisitionChannel', async () => {
      const channels = ['facebook', 'instagram', 'whatsapp', 'linkedin', 'site'] as const;

      for (const channel of channels) {
        mockGetProgressExecute.mockReset();
        mockAssertWorkerCanApply.mockReset();
        mockRecordExecute.mockReset();

        mockWorkerFound({ id: WORKER_ID });
        mockAssertWorkerCanApply.mockRejectedValueOnce(
          new WorkerNotEligibleError(WORKER_ID, 'registration_incomplete', 'INCOMPLETE_REGISTER'),
        );
        mockRecordExecute.mockResolvedValueOnce(undefined);

        const req = mockReq({ body: { jobPostingId: JOB_POSTING_ID, channel } });
        const res = mockRes();
        await controller.trackChannel(req as never, res as never);

        expect(mockRecordExecute).toHaveBeenCalledWith(
          expect.objectContaining({ acquisitionChannel: channel }),
        );
      }
    });
  });

  // ── Branches resolveWorker (`|| ''`) ─────────────────────────────

  it('name="" quando firstName e lastName são undefined (branch `|| ""`)', async () => {
    // Cobre linha 60: name || ''
    mockGetProgressExecute.mockResolvedValueOnce({
      isFailure: false,
      getValue: () => ({ id: WORKER_ID }),
    });
    mockAssertWorkerCanApply.mockResolvedValueOnce(undefined);
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = mockRes();
    await controller.trackChannel(mockReq() as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('phone="" quando phone é undefined (branch `|| ""`)', async () => {
    // Cobre linha 60: w.phone || ''
    mockGetProgressExecute.mockResolvedValueOnce({
      isFailure: false,
      getValue: () => ({ id: WORKER_ID, firstName: 'Ana', lastName: 'Lima' }),
    });
    mockAssertWorkerCanApply.mockResolvedValueOnce(undefined);
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = mockRes();
    await controller.trackChannel(mockReq() as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ── 500 com "Unknown error" (branch erro não-Error) ────────────────

  it('500 com "Unknown error" quando erro não-Error lança', async () => {
    // Cobre linha 158: `error instanceof Error ? error.message : 'Unknown error'`
    mockGetProgressExecute.mockRejectedValueOnce('not an error object');

    const res = mockRes();
    await controller.trackChannel(mockReq() as never, res as never);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Unknown error' }),
    );
  });

  // ── 500 não chama record para erros desconhecidos ─────────────────

  it('erro não-WorkerNotEligibleError não chama recordBlockedAttemptUseCase', async () => {
    mockWorkerFound();
    mockAssertWorkerCanApply.mockRejectedValueOnce(new Error('network failure'));

    const res = mockRes();
    await controller.trackChannel(mockReq() as never, res as never);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockRecordExecute).not.toHaveBeenCalled();
  });
});
