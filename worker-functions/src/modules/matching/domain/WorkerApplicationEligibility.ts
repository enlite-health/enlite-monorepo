import { Pool } from 'pg';
import { workerAptoSql } from '@shared/database/workerAptoSql';

export type WorkerEligibilityReason =
  | 'worker_not_found'
  | 'registration_incomplete'
  | 'worker_disabled';

/**
 * Motivos do gate de POSTULAÇÃO (`assertWorkerCanApply`) — os que `worker_blocked_applications` sabe gravar.
 * `documents_not_validated` (spec 067 FR-24) é o motivo do limiar de APTO (`assertWorkerApto`) e NÃO entra aqui:
 * a postulação segue no limiar REGISTERED (A12), então tentativa barrada nunca carrega esse motivo.
 */
export type WorkerNotEligibleReason = WorkerEligibilityReason | 'documents_not_validated';

export function isBlockedAttemptReason(reason: WorkerNotEligibleReason): reason is WorkerEligibilityReason {
  return reason !== 'documents_not_validated';
}

export class WorkerNotEligibleError extends Error {
  readonly code = 'WORKER_NOT_ELIGIBLE';
  readonly status = 403;

  constructor(
    readonly workerId: string,
    readonly reason: WorkerNotEligibleReason,
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

/**
 * Spec 067 FR-24: o limiar de "apto" (completo + documentos obrigatórios VALIDADOS) para entrar em Completado/encuadre.
 *
 * Chama `assertWorkerCanApply` primeiro (mesmos 3 motivos de hoje) e depois pergunta ao dono (`fn_worker_is_apto`).
 * Falso → `WorkerNotEligibleError('documents_not_validated')`, o mesmo contrato 403/`WORKER_NOT_ELIGIBLE` que o front já trata.
 *
 * ⚠️ NÃO usar na postulação (ApplyToVacancyUseCase): lá o limiar continua sendo `assertWorkerCanApply` (spec 067 A12).
 */
export async function assertWorkerApto(pool: Pool, workerId: string): Promise<void> {
  await assertWorkerCanApply(pool, workerId);

  const { rows } = await pool.query<{ apto: boolean }>(`SELECT ${workerAptoSql('$1')} AS apto`, [workerId]);
  if (rows[0]?.apto !== true) {
    throw new WorkerNotEligibleError(workerId, 'documents_not_validated', 'REGISTERED');
  }
}
