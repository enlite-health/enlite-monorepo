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

  it('exclui workers merged (merged_into_id IS NOT NULL) via WHERE clause', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as import('pg').Pool;
    await expect(assertWorkerCanApply(pool, 'w-merged')).rejects.toMatchObject({
      reason: 'worker_not_found',
    });
    expect(query.mock.calls[0][0]).toContain('merged_into_id IS NULL');
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
