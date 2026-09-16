/**
 * SourceRunRepository — patient_source_runs (migration 296).
 * `error` NUNCA recebe linha de dado: só nome de coluna/cabeçalho ou mensagem
 * sem PII (lex (e)2). Quem chama é responsável por passar texto limpo.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { Country, RunCompleteness, RunTrigger, Source } from '../domain/enums';

export interface SourceRun {
  readonly id: string;
  readonly source: Source;
  readonly country: Country;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly expectedCount: number | null;
  readonly readCount: number;
  readonly completeness: RunCompleteness;
  readonly triggeredBy: RunTrigger;
  readonly actorId: string | null;
  readonly error: string | null;
}

export interface StartRunInput {
  readonly source: Source;
  readonly country: Country;
  readonly triggeredBy: RunTrigger;
  readonly actorId?: string | null;
}

export interface FinishRunInput {
  readonly expectedCount: number | null;
  readonly readCount: number;
  readonly completeness: RunCompleteness;
  readonly error?: string | null;
}

const COLS = `id, source, country, started_at AS "startedAt", finished_at AS "finishedAt",
  expected_count AS "expectedCount", read_count AS "readCount", completeness,
  triggered_by AS "triggeredBy", actor_id AS "actorId", error`;

type Q = Pick<Pool, 'query'> | PoolClient;

export class SourceRunRepository {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async start(input: StartRunInput, q: Q = this.pool): Promise<SourceRun> {
    const res = await q.query<SourceRun>(
      `INSERT INTO patient_source_runs (source, country, triggered_by, actor_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLS}`,
      [input.source, input.country, input.triggeredBy, input.actorId ?? null],
    );
    return res.rows[0];
  }

  async finish(runId: string, input: FinishRunInput, q: Q = this.pool): Promise<SourceRun> {
    const res = await q.query<SourceRun>(
      `UPDATE patient_source_runs
          SET finished_at = NOW(), expected_count = $2, read_count = $3, completeness = $4, error = $5
        WHERE id = $1
       RETURNING ${COLS}`,
      [runId, input.expectedCount, input.readCount, input.completeness, input.error ?? null],
    );
    return res.rows[0];
  }

  async findById(runId: string): Promise<SourceRun | null> {
    const res = await this.pool.query<SourceRun>(`SELECT ${COLS} FROM patient_source_runs WHERE id = $1`, [runId]);
    return res.rows[0] ?? null;
  }

  /** Última rodada NÃO-FAILED de uma fonte (a que vale para inventário/diff). */
  async findLatestUsable(source: Source, country: Country): Promise<SourceRun | null> {
    const res = await this.pool.query<SourceRun>(
      `SELECT ${COLS} FROM patient_source_runs
        WHERE source = $1 AND country = $2 AND completeness <> 'FAILED' AND finished_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
      [source, country],
    );
    return res.rows[0] ?? null;
  }

  async list(opts: { source?: Source; limit?: number } = {}): Promise<SourceRun[]> {
    const res = await this.pool.query<SourceRun>(
      `SELECT ${COLS} FROM patient_source_runs
        WHERE ($1::text IS NULL OR source = $1)
        ORDER BY started_at DESC LIMIT $2`,
      [opts.source ?? null, Math.min(opts.limit ?? 50, 200)],
    );
    return res.rows;
  }
}
