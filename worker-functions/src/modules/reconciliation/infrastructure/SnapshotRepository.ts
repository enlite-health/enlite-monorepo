/**
 * SnapshotRepository — patient_source_snapshots (migration 296).
 *
 * Retenção (lex (a)): só o ÚLTIMO snapshot por (source, external_id).
 *  - `writeIfChanged` compara o content_hash com o último gravado: igual → não
 *    grava (e conta como "unchanged"); diferente → grava o novo e APAGA o
 *    anterior no mesmo statement lógico.
 *  - `purgeByPatient` (C5) é chamada pelo soft-delete do paciente.
 *
 * `canonical` só entra depois de `containsForbiddenKeys` = false (C2) — a
 * checagem é aqui, na última porta antes do banco, e não confia no leitor.
 */
import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { Country, Source } from '../domain/enums';
import { containsForbiddenKeys, type CanonicalPatient } from '../domain/CanonicalPatient';

export interface SnapshotRow {
  readonly id: string;
  readonly runId: string;
  readonly source: Source;
  readonly country: Country;
  readonly externalId: string;
  readonly canonical: CanonicalPatient;
  readonly contentHash: string;
  readonly readAt: Date;
}

export type WriteOutcome = 'CREATED' | 'REPLACED' | 'UNCHANGED';

const COLS = `id, run_id AS "runId", source, country, external_id AS "externalId",
  canonical, content_hash AS "contentHash", read_at AS "readAt"`;

type Q = Pick<Pool, 'query'> | PoolClient;

export function hashCanonical(c: CanonicalPatient): string {
  // chaves ordenadas → hash estável independente da ordem de construção
  const stable = JSON.stringify(c, Object.keys(c).sort());
  return createHash('sha256').update(stable).digest('hex');
}

export class ForbiddenCanonicalError extends Error {
  constructor(externalId: string) {
    super(`canonical for ${externalId} contains forbidden keys (lex C2)`);
    this.name = 'ForbiddenCanonicalError';
  }
}

export class SnapshotRepository {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async writeIfChanged(
    input: { runId: string; source: Source; country: Country; externalId: string; canonical: CanonicalPatient },
    q: Q = this.pool,
  ): Promise<WriteOutcome> {
    if (containsForbiddenKeys(input.canonical)) throw new ForbiddenCanonicalError(input.externalId);
    const hash = hashCanonical(input.canonical);

    const prev = await q.query<{ id: string; contentHash: string }>(
      `SELECT id, content_hash AS "contentHash" FROM patient_source_snapshots
        WHERE source = $1 AND external_id = $2
        ORDER BY read_at DESC LIMIT 1`,
      [input.source, input.externalId],
    );
    const last = prev.rows[0];
    if (last && last.contentHash === hash) return 'UNCHANGED';

    await q.query(
      `INSERT INTO patient_source_snapshots (run_id, source, country, external_id, canonical, content_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (run_id, source, external_id) DO UPDATE
         SET canonical = EXCLUDED.canonical, content_hash = EXCLUDED.content_hash, read_at = NOW()`,
      [input.runId, input.source, input.country, input.externalId, JSON.stringify(input.canonical), hash],
    );
    if (last) {
      await q.query(`DELETE FROM patient_source_snapshots WHERE id = $1`, [last.id]);
      return 'REPLACED';
    }
    return 'CREATED';
  }

  /** Último snapshot vivo de cada registro de uma fonte (para inventário/diff). */
  async latestBySource(source: Source, country: Country): Promise<SnapshotRow[]> {
    const res = await this.pool.query<SnapshotRow>(
      `SELECT DISTINCT ON (external_id) ${COLS}
         FROM patient_source_snapshots
        WHERE source = $1 AND country = $2
        ORDER BY external_id, read_at DESC`,
      [source, country],
    );
    return res.rows;
  }

  async findLatest(source: Source, externalId: string): Promise<SnapshotRow | null> {
    const res = await this.pool.query<SnapshotRow>(
      `SELECT ${COLS} FROM patient_source_snapshots
        WHERE source = $1 AND external_id = $2 ORDER BY read_at DESC LIMIT 1`,
      [source, externalId],
    );
    return res.rows[0] ?? null;
  }

  /** C5: soft-delete do paciente purga tudo dele nas fontes ligadas. */
  async purgeByPatient(patientId: string, q: Q = this.pool): Promise<number> {
    const res = await q.query(
      `DELETE FROM patient_source_snapshots s
        USING patient_identity_links l
        WHERE l.patient_id = $1 AND l.source = s.source AND l.external_id = s.external_id`,
      [patientId],
    );
    return res.rowCount ?? 0;
  }

  async countByRun(runId: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM patient_source_snapshots WHERE run_id = $1`, [runId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }
}
