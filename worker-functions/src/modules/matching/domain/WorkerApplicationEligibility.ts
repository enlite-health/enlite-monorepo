import { Pool } from 'pg';

export type WorkerEligibilityReason =
  | 'worker_not_found'
  | 'registration_incomplete'
  | 'worker_disabled';

export class WorkerNotEligibleError extends Error {
  readonly code = 'WORKER_NOT_ELIGIBLE';
  readonly status = 403;

  constructor(
    readonly workerId: string,
    readonly reason: WorkerEligibilityReason,
    readonly workerStatus: string | null,
  ) {
    super(
      reason === 'worker_not_found'
        ? `worker ${workerId} not found`
        : `worker ${workerId} is not eligible to apply (status=${workerStatus})`,
    );
    this.name = 'WorkerNotEligibleError';
  }
}

export async function assertWorkerCanApply(pool: Pool, workerId: string): Promise<void> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM workers WHERE id = $1 AND merged_into_id IS NULL',
    [workerId],
  );

  if (rows.length === 0) {
    throw new WorkerNotEligibleError(workerId, 'worker_not_found', null);
  }

  const status = rows[0].status;

  if (status === 'DISABLED') {
    throw new WorkerNotEligibleError(workerId, 'worker_disabled', status);
  }

  if (status !== 'REGISTERED') {
    throw new WorkerNotEligibleError(workerId, 'registration_incomplete', status);
  }
}
