/**
 * SnapshotSourceWithLockUseCase — snapshot completo de UMA fonte por API
 * (ClickUp ou Ana Care), serializado por advisory lock (spec 003, H1 / R1 / R6).
 *
 * Lock próprio (86010724) — o do espelho de 10 min é outro (86010723) e
 * continua intocado. BUSY se já há rodada rodando. A leitura completa do
 * ClickUp leva ~12 min (347 tasks): vive em rota/scheduler próprios.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { RECONCILIATION_ADVISORY_LOCK_KEY, type Country, type RunTrigger, type Source } from '../domain/enums';
import type { PatientSourceReader } from '../domain/PatientSourceReader';
import type { SnapshotSourceUseCase, SnapshotResult } from './SnapshotSourceUseCase';

export interface SnapshotWithLockDeps {
  /** Constrói o leitor da fonte — I/O externo fica fora do construtor. */
  readerFactory: (source: Source, country: Country) => Promise<PatientSourceReader>;
  snapshot: Pick<SnapshotSourceUseCase, 'execute'>;
  pool?: Pool;
}

export type SnapshotWithLockOutcome =
  | { kind: 'BUSY' }
  | { kind: 'DONE'; result: SnapshotResult };

export class SnapshotSourceWithLockUseCase {
  private readonly pool: Pool;

  constructor(private readonly deps: SnapshotWithLockDeps) {
    this.pool = deps.pool ?? DatabaseConnection.getInstance().getPool();
  }

  async execute(input: { source: Source; country: Country; triggeredBy: RunTrigger; actorId?: string | null }): Promise<SnapshotWithLockOutcome> {
    // Advisory lock: adquirido e liberado no MESMO client (molde: ReconcileClickUpPatientsUseCase).
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RECONCILIATION_ADVISORY_LOCK_KEY]);
      if (!lock.rows[0]?.locked) return { kind: 'BUSY' };
      try {
        const reader = await this.deps.readerFactory(input.source, input.country);
        const result = await this.deps.snapshot.execute({ reader, triggeredBy: input.triggeredBy, actorId: input.actorId ?? null });
        return { kind: 'DONE', result };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [RECONCILIATION_ADVISORY_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}
