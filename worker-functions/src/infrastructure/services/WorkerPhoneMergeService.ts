/**
 * WorkerPhoneMergeService
 *
 * Executa (ou simula em dry-run) o merge de workers duplicados por phone_normalized.
 *
 * Regras do sobrevivente (por grupo de mesmo phone_normalized, merged_into_id IS NULL):
 *   1. Exatamente 1 membro com auth_uid Firebase REAL → sobrevivente (categoria: firebase).
 *   2. 0 Firebase real → sobrevivente = mais completo + mais documentos + updated_at mais
 *      recente (categoria: most_complete).
 *   3. >1 Firebase real → CONFLITO: não mergear; exportar para relatório (sem categoria).
 *
 * Ghost reconciliation (email LIKE '%@enlite.import'):
 *   - Ghost COM phone → procura worker real (email válido) com mesmo phone_normalized
 *     → mergear ghost NO real (real é sobrevivente, categoria: ghost).
 *   - Ghost SEM match → listar como candidato a desativar.
 *
 * Campos legais (document_number_encrypted, worker_documents, worker_payment_info):
 *   - NUNCA auto-sobrescritos quando divergentes → registrar em exceptions.
 *   - COALESCE seguro: só preenche se o sobrevivente estava NULL.
 *
 * FK reparent: todas as tabelas listadas em FK_TABLES_TO_REPARENT.
 * Auditoria: worker_merge_audit (migration 221).
 */

import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger, reportError } from '@shared/logging';
import {
  type WorkerInGroup,
  type MergeGroupPlan,
  type MergePlanReport,
  type MergeExecutionResult,
  type MergeError,
  type GhostMatchPlan,
  type GhostOrphan,
  type LegalFieldException,
  type MergeCategory,
  SYNTHETIC_AUTH_UID_PREFIXES,
  LEGAL_FIELDS,
  FK_TABLES_TO_REPARENT,
} from './WorkerPhoneMergeTypes';
import {
  buildGroupPlans,
  resolveGhosts,
  coalesceWorkerFields,
  buildReparentQueries,
} from './WorkerPhoneMergeHelpers';
// buildReparentQueries is re-exported from WorkerPhoneMergeReparent via WorkerPhoneMergeHelpers

const log = logger.child({ source: 'WorkerPhoneMergeService' });

export class WorkerPhoneMergeService {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Modo DRY-RUN: lê o banco e emite o plano completo SEM escrever nada.
   * Retorna MergePlanReport para aprovação humana.
   */
  async dryRun(): Promise<MergePlanReport> {
    log.info({ msg: 'dry_run_start' });

    const collisionGroups = await this.fetchCollisionGroups();
    const groupPlans = await buildGroupPlans(collisionGroups, this.pool);
    const { ghostMatches, ghostOrphans } = await resolveGhosts(this.pool);

    const conflictGroups = groupPlans.filter(p => p.category === 'conflict');
    const mergeablePlans = groupPlans.filter(
      p => p.category === 'firebase' || p.category === 'most_complete',
    );

    const report: MergePlanReport = {
      analyzed_at: new Date().toISOString(),
      total_collision_groups: groupPlans.length,
      total_firebase_groups: groupPlans.filter(p => p.category === 'firebase').length,
      total_most_complete_groups: groupPlans.filter(p => p.category === 'most_complete').length,
      total_conflict_groups: conflictGroups.length,
      total_ghost_matches: ghostMatches.length,
      total_ghost_orphans: ghostOrphans.length,
      group_plans: groupPlans,
      ghost_matches: ghostMatches,
      ghost_orphans: ghostOrphans,
      conflict_groups: conflictGroups,
      total_merges_planned:
        mergeablePlans.reduce((sum, p) => sum + p.absorbed_ids.length, 0) +
        ghostMatches.length,
      analysis_errors: [],
    };

    log.info({
      msg: 'dry_run_complete',
      total_collision_groups: report.total_collision_groups,
      firebase_groups: report.total_firebase_groups,
      most_complete_groups: report.total_most_complete_groups,
      conflict_groups: report.total_conflict_groups,
      ghost_matches: report.total_ghost_matches,
      ghost_orphans: report.total_ghost_orphans,
      merges_planned: report.total_merges_planned,
    });

    return report;
  }

  /**
   * Execução real: aplica os merges em transações atômicas.
   * Idempotente: re-execução não altera workers já mergeados.
   */
  async execute(): Promise<MergeExecutionResult> {
    const executionStartedAt = new Date().toISOString();
    log.info({ msg: 'merge_execute_start' });

    const plan = await this.dryRun();
    const errors: MergeError[] = [];
    let mergesExecuted = 0;
    let mergesSkipped = 0;

    // Merges por grupo de colisão (firebase + most_complete)
    for (const groupPlan of plan.group_plans) {
      if (groupPlan.category === 'conflict' || groupPlan.category === 'skip') {
        mergesSkipped += groupPlan.absorbed_ids.length;
        continue;
      }

      for (const absorbedId of groupPlan.absorbed_ids) {
        try {
          await this.executeSingleMerge({
            survivorId: groupPlan.survivor_id!,
            absorbedId,
            phoneNormalized: groupPlan.phone_normalized,
            category: groupPlan.category as MergeCategory,
            legalFieldExceptions: groupPlan.legal_field_exceptions,
          });
          mergesExecuted++;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { source: 'WorkerPhoneMergeService:execute', absorbedId });
          errors.push({
            phone_normalized: groupPlan.phone_normalized,
            survivor_id: groupPlan.survivor_id,
            absorbed_id: absorbedId,
            error: error.message,
          });
        }
      }
    }

    // Ghost merges
    for (const ghostMatch of plan.ghost_matches) {
      try {
        await this.executeSingleMerge({
          survivorId: ghostMatch.real_id,
          absorbedId: ghostMatch.ghost_id,
          phoneNormalized: ghostMatch.phone_normalized,
          category: 'ghost',
          legalFieldExceptions: [],
        });
        mergesExecuted++;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        reportError(error, { source: 'WorkerPhoneMergeService:execute:ghost', ghostId: ghostMatch.ghost_id });
        errors.push({
          phone_normalized: ghostMatch.phone_normalized,
          survivor_id: ghostMatch.real_id,
          absorbed_id: ghostMatch.ghost_id,
          error: error.message,
        });
      }
    }

    log.info({
      msg: 'merge_execute_complete',
      merges_executed: mergesExecuted,
      merges_skipped: mergesSkipped,
      errors: errors.length,
    });

    return {
      plan,
      merges_executed: mergesExecuted,
      merges_skipped: mergesSkipped,
      errors,
      execution_started_at: executionStartedAt,
      execution_finished_at: new Date().toISOString(),
    };
  }

  // ── Core merge transaction ─────────────────────────────────────────────────

  async executeSingleMerge(params: {
    survivorId: string;
    absorbedId: string;
    phoneNormalized: string;
    category: MergeCategory;
    legalFieldExceptions: LegalFieldException[];
  }): Promise<void> {
    const { survivorId, absorbedId, phoneNormalized, category, legalFieldExceptions } = params;

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Verifica idempotência: absorvido já mergeado?
      const checkRow = await client.query(
        'SELECT merged_into_id FROM workers WHERE id = $1',
        [absorbedId],
      );
      if (checkRow.rows[0]?.merged_into_id != null) {
        await client.query('ROLLBACK');
        log.info({ msg: 'merge_skip_already_merged', absorbedId, survivorId });
        return;
      }

      // 2. COALESCE: preenche campos nulos do sobrevivente com valores do absorvido
      const { fieldsFilled } = await coalesceWorkerFields(client, survivorId, absorbedId);

      // 3. Reparent de todas as tabelas FK
      const reparentQueries = buildReparentQueries(survivorId, absorbedId);
      for (const q of reparentQueries) {
        await client.query(q.sql, q.params);
      }

      // 4. Soft-delete do absorvido
      await client.query(
        `UPDATE workers SET merged_into_id = $1, updated_at = NOW() WHERE id = $2`,
        [survivorId, absorbedId],
      );

      // 5. Registrar auditoria
      await client.query(
        `INSERT INTO worker_merge_audit
           (survivor_id, absorbed_id, phone_normalized, category, fields_filled, exceptions)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          survivorId,
          absorbedId,
          phoneNormalized,
          category,
          JSON.stringify(fieldsFilled),
          JSON.stringify(legalFieldExceptions),
        ],
      );

      await client.query('COMMIT');

      log.info({
        msg: 'merge_executed',
        survivorId,
        absorbedId,
        category,
        fields_filled: fieldsFilled.length,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Busca grupos de colisão da tabela worker_phone_collisions (migration 220). */
  private async fetchCollisionGroups(): Promise<Array<{ phone_normalized: string; worker_ids: string[] }>> {
    const result = await this.pool.query<{ phone_normalized: string; worker_ids: string[] }>(
      `SELECT phone_normalized, worker_ids
       FROM worker_phone_collisions
       WHERE resolved_at IS NULL
       ORDER BY worker_count DESC`,
    );
    return result.rows;
  }
}

// ─── Re-exports para facilitar os testes ────────────────────────────────────

export type {
  MergePlanReport,
  MergeExecutionResult,
  MergeGroupPlan,
  GhostMatchPlan,
  GhostOrphan,
  WorkerInGroup,
  LegalFieldException,
};

export {
  SYNTHETIC_AUTH_UID_PREFIXES,
  LEGAL_FIELDS,
  FK_TABLES_TO_REPARENT,
};
