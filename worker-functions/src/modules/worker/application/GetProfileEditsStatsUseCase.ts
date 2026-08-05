/**
 * GetProfileEditsStatsUseCase
 *
 * Distribuição de edições de campo de perfil por FONTE no período — a leitura
 * de mensuração da change luz-cadastro-assistido-rastreavel ("por onde vêm as
 * edições?"). Lê worker_profile_changes_audit (trilha única de campo); linhas
 * históricas com changed_by='luz' (default da mig 202, pré-enum) são
 * normalizadas para 'luz_conversation'.
 *
 * Zero PII: só contagens por fonte.
 */

import { Pool } from 'pg';

export interface ProfileEditsSourceStats {
  /** Fonte canônica (profileEditSource) ou valor legado normalizado. */
  source: string;
  /** Total de linhas de edição (uma por campo escrito). */
  edits: number;
  /** Workers distintos editados pela fonte no período. */
  workers: number;
  lastEditAt: string | null;
}

export interface ProfileEditsStatsResult {
  sinceDays: number;
  totalEdits: number;
  bySource: ProfileEditsSourceStats[];
}

export class GetProfileEditsStatsUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(input: { sinceDays: number }): Promise<ProfileEditsStatsResult> {
    const { rows } = await this.pool.query<{
      source: string;
      edits: string;
      workers: string;
      last_edit_at: Date | null;
    }>(
      `SELECT
         CASE WHEN changed_by = 'luz' THEN 'luz_conversation' ELSE changed_by END AS source,
         COUNT(*)                 AS edits,
         COUNT(DISTINCT worker_id) AS workers,
         MAX(created_at)          AS last_edit_at
       FROM worker_profile_changes_audit
       WHERE created_at >= NOW() - make_interval(days => $1)
       GROUP BY 1
       ORDER BY 2 DESC`,
      [input.sinceDays],
    );

    const bySource = rows.map((r) => ({
      source: r.source,
      edits: Number(r.edits),
      workers: Number(r.workers),
      lastEditAt: r.last_edit_at ? r.last_edit_at.toISOString() : null,
    }));

    return {
      sinceDays: input.sinceDays,
      totalEdits: bySource.reduce((acc, s) => acc + s.edits, 0),
      bySource,
    };
  }
}
