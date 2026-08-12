/**
 * BackfillWorkerMirrorUseCase — espelha workers elegíveis para um provider externo.
 *
 * dryRun=true (default): apenas conta e loga o que seria enviado, SEM rede.
 * dryRun=false: chama MirrorWorkerService.mirrorOne() para cada worker elegível.
 *
 * Elegibilidade (v2 — sem gate REGISTERED):
 *   - first_name_encrypted IS NOT NULL
 *   - last_name_encrypted IS NOT NULL
 *   - sex_encrypted IS NOT NULL
 *   - email NOT LIKE '%@enlite.import' (workers sintéticos de import)
 *   - merged_into_id IS NULL
 *   - phone_normalized NÃO em grupo de colisão não resolvida (duplicados por phone)
 *
 * Endereço: JOIN worker_service_areas ORDER BY created_at ASC LIMIT 1 (mais antiga =
 * principal, convenção; não existe is_primary).
 *
 * PII-SAFETY: campos decriptados NUNCA aparecem em logs nem em ana_care_sync_error.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';
import type { WorkerMirrorProvider } from '../domain/WorkerMirrorProvider';
import { MirrorWorkerService } from './MirrorWorkerService';

const TAG = '[BackfillWorkerMirror]';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface BackfillOptions {
  /** dryRun=true (padrão): não faz rede, só conta/loga */
  dryRun?: boolean;
  /** Máximo de workers a processar nesta execução */
  limit?: number;
}

export interface BackfillSummary {
  eligible: number;
  created: number;
  updated: number;
  skipped: number;
  deactivated: number;
  errors: Array<{ workerId: string; message: string }>;
}

// ─────────────────────────────────────────────────────────────────
// Eligible worker row from DB
// ─────────────────────────────────────────────────────────────────

interface EligibleWorkerRow {
  id: string;
  ana_care_id: string | null;
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class BackfillWorkerMirrorUseCase {
  private readonly db: Pool;
  private readonly providerFactory: () => Promise<WorkerMirrorProvider>;

  /**
   * @param providerFactory cria o provider SOB DEMANDA — só é chamado quando há
   *   upsert real (dryRun=false). Em dryRun nenhum client externo é instanciado
   *   (sem Secret Manager / sem KMS), então o preview roda em qualquer ambiente.
   */
  constructor(providerFactory: () => Promise<WorkerMirrorProvider>) {
    this.db = DatabaseConnection.getInstance().getPool();
    this.providerFactory = providerFactory;
  }

  async execute(opts: BackfillOptions = {}): Promise<BackfillSummary> {
    const dryRun = opts.dryRun !== false; // default: true
    const limit = opts.limit ?? 500;

    logger.info({ msg: `${TAG} starting`, dryRun, limit });

    const rows = await this.fetchEligibleWorkers(limit);
    const summary: BackfillSummary = {
      eligible: rows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      deactivated: 0,
      errors: [],
    };

    logger.info({ msg: `${TAG} eligible workers found`, count: rows.length, dryRun });

    // dryRun: preview puro — NÃO decripta PII nem cria client externo.
    // Conta novo (POST) vs existente (PATCH) apenas por ana_care_id.
    if (dryRun) {
      for (const row of rows) {
        if (row.ana_care_id) { summary.updated++; } else { summary.created++; }
      }
      logger.info({ msg: `${TAG} dryRun done`, ...summary });
      return summary;
    }

    const provider = await this.providerFactory();
    const service = new MirrorWorkerService(provider);

    for (const row of rows) {
      const log = logger.child({ workerId: row.id });
      try {
        const result = await service.mirrorOne(row.id);
        switch (result) {
          case 'created':    summary.created++;     break;
          case 'updated':    summary.updated++;     break;
          case 'skipped':    summary.skipped++;     break;
          case 'deactivated': summary.deactivated++; break;
        }
        log.info({ msg: `${TAG} processed`, action: result });
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        // persistError + reportError já foram feitos dentro do service
        const errorMsg = e.message.slice(0, 500);
        summary.errors.push({ workerId: row.id, message: errorMsg });
      }
    }

    logger.info({
      msg: `${TAG} done`,
      provider: provider.name,
      dryRun,
      ...summary,
      errorCount: summary.errors.length,
    });

    return summary;
  }

  // ── Query de elegibilidade ────────────────────────────────────────

  private async fetchEligibleWorkers(limit: number): Promise<EligibleWorkerRow[]> {
    // Critérios de elegibilidade:
    //   - status = 'REGISTERED' (gate principal — só workers completos)
    //   - Email não sintético (@enlite.import)
    //   - Não mergeado
    //   - Sem colisão de phone não resolvida
    //
    // Endereço: JOIN worker_service_areas ORDER BY created_at ASC LIMIT 1
    // (mais antiga = principal, convenção; não há is_primary).
    const { rows } = await this.db.query<EligibleWorkerRow>(
      `SELECT
         w.id,
         w.ana_care_id
       FROM workers w
       WHERE w.status = 'REGISTERED'
         AND w.merged_into_id IS NULL
         AND w.email NOT LIKE '%@enlite.import'
         AND (
           w.phone_normalized IS NULL
           OR w.phone_normalized NOT IN (
             SELECT phone_normalized
             FROM workers
             WHERE merged_into_id IS NULL AND phone_normalized IS NOT NULL
             GROUP BY phone_normalized
             HAVING count(*) > 1
           )
         )
       ORDER BY w.created_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }
}
