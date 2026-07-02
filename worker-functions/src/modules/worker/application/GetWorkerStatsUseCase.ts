import type { Pool } from 'pg';

export interface WorkerStatsResult {
  /** Workers não-merged (dedup) — o "total de prestadores cadastrados". */
  totalWorkers: number;
  /** Contagem por workers.status (ex: REGISTERED, INCOMPLETE_REGISTER). */
  byStatus: Record<string, number>;
  /**
   * Contagem de POSTULAÇÕES por etapa do funil (worker_job_applications).
   * Um worker pode ter N postulações — isso conta aplicações, não workers.
   */
  applicationsByFunnelStage: Record<string, number>;
  /** Cadastros novos (created_at) hoje e nos últimos 7 dias. */
  registeredToday: number;
  registeredLast7Days: number;
}

/**
 * Agregações globais de workers pro MCP (worker.stats.get). Só COUNT/GROUP BY —
 * nunca toca colunas *_encrypted (zero PII).
 */
export class GetWorkerStatsUseCase {
  constructor(private readonly db: Pool) {}

  async execute(): Promise<WorkerStatsResult> {
    const [totals, byStatus, byStage] = await Promise.all([
      this.db.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today,
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')::int AS last7
         FROM workers
         WHERE merged_into_id IS NULL`,
      ),
      this.db.query(
        `SELECT status, COUNT(*)::int AS count
         FROM workers
         WHERE merged_into_id IS NULL
         GROUP BY status
         ORDER BY count DESC`,
      ),
      this.db.query(
        `SELECT application_funnel_stage AS stage, COUNT(*)::int AS count
         FROM worker_job_applications
         GROUP BY application_funnel_stage
         ORDER BY count DESC`,
      ),
    ]);

    const totalsRow = totals.rows[0] as { total: number; today: number; last7: number };
    return {
      totalWorkers: totalsRow.total,
      byStatus: rowsToRecord(byStatus.rows as Array<{ status: string; count: number }>, 'status'),
      applicationsByFunnelStage: rowsToRecord(
        byStage.rows as Array<{ stage: string; count: number }>,
        'stage',
      ),
      registeredToday: totalsRow.today,
      registeredLast7Days: totalsRow.last7,
    };
  }
}

function rowsToRecord<K extends string>(
  rows: Array<Record<K, string> & { count: number }>,
  key: K,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const row of rows) {
    record[row[key] ?? 'UNKNOWN'] = row.count;
  }
  return record;
}
