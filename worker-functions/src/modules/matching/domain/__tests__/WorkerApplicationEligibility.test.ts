import {
  assertWorkerApto,
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

describe('assertWorkerApto (spec 067 FR-24)', () => {
  /** 1ª query = status (assertWorkerCanApply); 2ª = fn_worker_is_apto. */
  function makePoolApto(status: string | null, apto: boolean | undefined) {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: status === null ? [] : [{ status }] })
      .mockResolvedValueOnce({ rows: apto === undefined ? [] : [{ apto }] });
    return { pool: { query } as unknown as import('pg').Pool, query };
  }

  it('REGISTERED e apto → resolve, e a 2ª query chama fn_worker_is_apto($1)', async () => {
    const { pool, query } = makePoolApto('REGISTERED', true);
    await expect(assertWorkerApto(pool, 'w-1')).resolves.toBeUndefined();
    expect(String(query.mock.calls[1][0])).toContain('fn_worker_is_apto($1)');
    expect(query.mock.calls[1][1]).toEqual(['w-1']);
  });

  it('REGISTERED sem documento validado → 403 documents_not_validated (WORKER_NOT_ELIGIBLE)', async () => {
    const { pool } = makePoolApto('REGISTERED', false);
    await expect(assertWorkerApto(pool, 'w-1')).rejects.toMatchObject({
      name: 'WorkerNotEligibleError',
      code: 'WORKER_NOT_ELIGIBLE',
      status: 403,
      reason: 'documents_not_validated',
    });
  });

  it('resposta sem linha / NULL → fail-closed (não apto)', async () => {
    const { pool } = makePoolApto('REGISTERED', undefined);
    await expect(assertWorkerApto(pool, 'w-1')).rejects.toMatchObject({ reason: 'documents_not_validated' });
  });

  it('os 3 motivos de hoje continuam vindo de assertWorkerCanApply (e a 2ª query nem roda)', async () => {
    const incompleto = makePoolApto('INCOMPLETE_REGISTER', true);
    await expect(assertWorkerApto(incompleto.pool, 'w-1')).rejects.toMatchObject({ reason: 'registration_incomplete' });
    expect(incompleto.query).toHaveBeenCalledTimes(1);

    const desativado = makePoolApto('DISABLED', true);
    await expect(assertWorkerApto(desativado.pool, 'w-1')).rejects.toMatchObject({ reason: 'worker_disabled' });

    const inexistente = makePoolApto(null, true);
    await expect(assertWorkerApto(inexistente.pool, 'w-x')).rejects.toMatchObject({ reason: 'worker_not_found' });
  });
});

describe('isBlockedAttemptReason (067): documents_not_validated nunca vira tentativa barrada', () => {
  it('só os 3 motivos da postulação são gravados em worker_blocked_applications', async () => {
    const { isBlockedAttemptReason } = await import('../WorkerApplicationEligibility');
    expect(isBlockedAttemptReason('worker_not_found')).toBe(true);
    expect(isBlockedAttemptReason('registration_incomplete')).toBe(true);
    expect(isBlockedAttemptReason('worker_disabled')).toBe(true);
    expect(isBlockedAttemptReason('documents_not_validated')).toBe(false);
  });
});
