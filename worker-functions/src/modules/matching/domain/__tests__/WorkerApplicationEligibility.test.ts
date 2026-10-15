jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));

import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
} from '../WorkerApplicationEligibility';

function makePool(rows: Array<{ status: string }>) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { query } as unknown as import('pg').Pool;
}

describe('assertWorkerCanApply', () => {
  it('resolve quando worker.status = REGISTERED', async () => {
    const pool = makePool([{ status: 'REGISTERED' }]);
    await expect(assertWorkerCanApply(pool, 'w-1')).resolves.toBeUndefined();
  });

  it('joga WorkerNotEligibleError(worker_not_found) quando worker não existe', async () => {
    const pool = makePool([]);
    await expect(assertWorkerCanApply(pool, 'w-missing')).rejects.toMatchObject({
      name: 'WorkerNotEligibleError',
      code: 'WORKER_NOT_ELIGIBLE',
      status: 403,
      reason: 'worker_not_found',
      workerStatus: null,
    });
  });

  it('joga WorkerNotEligibleError(registration_incomplete) quando status=INCOMPLETE_REGISTER', async () => {
    const pool = makePool([{ status: 'INCOMPLETE_REGISTER' }]);
    await expect(assertWorkerCanApply(pool, 'w-1')).rejects.toMatchObject({
      name: 'WorkerNotEligibleError',
      reason: 'registration_incomplete',
      workerStatus: 'INCOMPLETE_REGISTER',
    });
  });

  it('joga WorkerNotEligibleError(worker_disabled) quando status=DISABLED', async () => {
    const pool = makePool([{ status: 'DISABLED' }]);
    await expect(assertWorkerCanApply(pool, 'w-1')).rejects.toMatchObject({
      name: 'WorkerNotEligibleError',
      reason: 'worker_disabled',
      workerStatus: 'DISABLED',
    });
  });

  it('joga WorkerNotEligibleError pra qualquer status diferente de REGISTERED/DISABLED', async () => {
    const pool = makePool([{ status: 'UNKNOWN_STATUS' }]);
    await expect(assertWorkerCanApply(pool, 'w-1')).rejects.toMatchObject({
      reason: 'registration_incomplete',
      workerStatus: 'UNKNOWN_STATUS',
    });
  });

  describe('worker fundido (merged_into_id preenchido)', () => {
    // Fila: 1) SELECT status do id pedido (vivo) → 0 linhas; 2) CTE de resolveCanonicalWorkerId;
    // 3) SELECT status do canônico.
    function makeMergedPool(canonical: { id: string; depth: number } | null, canonicalStatus?: string) {
      const query = jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: canonical ? [{ ...canonical, merged_into_id: null }] : [] })
        .mockResolvedValueOnce({ rows: canonicalStatus ? [{ status: canonicalStatus }] : [] });
      return { pool: { query } as unknown as import('pg').Pool, query };
    }

    it('avalia o status do canônico vivo: REGISTERED → resolve', async () => {
      const { pool, query } = makeMergedPool({ id: 'w-live', depth: 1 }, 'REGISTERED');
      await expect(assertWorkerCanApply(pool, 'w-merged')).resolves.toBeUndefined();
      expect(query.mock.calls[2][1]).toEqual(['w-live']);
    });

    it('canônico INCOMPLETE_REGISTER → registration_incomplete (não worker_not_found)', async () => {
      const { pool } = makeMergedPool({ id: 'w-live', depth: 1 }, 'INCOMPLETE_REGISTER');
      await expect(assertWorkerCanApply(pool, 'w-merged')).rejects.toMatchObject({
        reason: 'registration_incomplete',
        workerStatus: 'INCOMPLETE_REGISTER',
      });
    });

    it('id realmente inexistente (ou corrente sem fim) → worker_not_found', async () => {
      const { pool, query } = makeMergedPool(null);
      await expect(assertWorkerCanApply(pool, 'w-missing')).rejects.toMatchObject({
        reason: 'worker_not_found',
        workerStatus: null,
      });
      expect(query).toHaveBeenCalledTimes(2); // sem SELECT de canônico
    });
  });

  it('WorkerNotEligibleError tem fields esperados', () => {
    const err = new WorkerNotEligibleError('w-1', 'registration_incomplete', 'INCOMPLETE_REGISTER');
    expect(err.code).toBe('WORKER_NOT_ELIGIBLE');
    expect(err.status).toBe(403);
    expect(err.workerId).toBe('w-1');
    expect(err.reason).toBe('registration_incomplete');
    expect(err.workerStatus).toBe('INCOMPLETE_REGISTER');
    expect(err).toBeInstanceOf(Error);
  });
});
