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
 * FK reparent — DESCOBERTA DINÂMICA (resiliente a drift de schema): consulta o
 *   information_schema pra achar toda FK → workers(id) (inclusive múltiplas colunas
 *   na mesma tabela) e reparenta. Ver WorkerPhoneMergeFkDiscovery.ts.
 *
 * Auditoria: worker_merge_audit (mig 221 + 227 ator/contexto). Escrita em
 *   WorkerMergeAuditWriter.ts.
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
  moveUniqueIdentityFields,
  buildReparentQueries,
  discoverWorkerFkTables,
  type FkTableInfo,
} from './WorkerPhoneMergeHelpers';
import { recalculateWorkerStatus } from '../../modules/worker/infrastructure/WorkerStatusRepository';
import { captureSnapshot } from './WorkerMergeSnapshotService';
import { insertMergeAuditRow, type MergeAuditInput } from './WorkerMergeAuditWriter';
import { undoMergeTx } from './WorkerMergeUndoService';
import type { UndoAuditContext } from '../../application/dedup/DedupTypes';

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
   *
   * A descoberta de FKs ocorre UMA VEZ antes do loop de merges,
   * fora de qualquer transação, e o resultado é reutilizado em todos os merges.
   */
  async execute(): Promise<MergeExecutionResult> {
    const executionStartedAt = new Date().toISOString();
    log.info({ msg: 'merge_execute_start' });

    // Descobre FKs uma vez, antes de qualquer merge
    const knownTables = FK_TABLES_TO_REPARENT.map(t => t.table);
    const discoveredFks = await discoverWorkerFkTables(this.pool, { knownTables });

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
            survivorId:           groupPlan.survivor_id!,
            absorbedId,
            phoneNormalized:      groupPlan.phone_normalized,
            category:             groupPlan.category as MergeCategory,
            legalFieldExceptions: groupPlan.legal_field_exceptions,
            discoveredFks,
          });
          mergesExecuted++;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { source: 'WorkerPhoneMergeService:execute', absorbedId });
          errors.push({
            phone_normalized: groupPlan.phone_normalized,
            survivor_id:      groupPlan.survivor_id,
            absorbed_id:      absorbedId,
            error:            error.message,
          });
        }
      }
    }

    // Ghost merges
    for (const ghostMatch of plan.ghost_matches) {
      try {
        await this.executeSingleMerge({
          survivorId:           ghostMatch.real_id,
          absorbedId:           ghostMatch.ghost_id,
          phoneNormalized:      ghostMatch.phone_normalized,
          category:             'ghost',
          legalFieldExceptions: [],
          discoveredFks,
        });
        mergesExecuted++;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        reportError(error, { source: 'WorkerPhoneMergeService:execute:ghost', ghostId: ghostMatch.ghost_id });
        errors.push({
          phone_normalized: ghostMatch.phone_normalized,
          survivor_id:      ghostMatch.real_id,
          absorbed_id:      ghostMatch.ghost_id,
          error:            error.message,
        });
      }
    }

    log.info({
      msg:             'merge_execute_complete',
      merges_executed: mergesExecuted,
      merges_skipped:  mergesSkipped,
      errors:          errors.length,
    });

    return {
      plan,
      merges_executed:        mergesExecuted,
      merges_skipped:         mergesSkipped,
      errors,
      execution_started_at:   executionStartedAt,
      execution_finished_at:  new Date().toISOString(),
    };
  }

  // ── Core merge transaction ─────────────────────────────────────────────────

  async executeSingleMerge(params: {
    survivorId:           string;
    absorbedId:           string;
    phoneNormalized:      string;
    category:             MergeCategory;
    legalFieldExceptions: LegalFieldException[];
    /**
     * Lista de FKs descobertas dinamicamente.
     * Se não fornecida (chamada direta em testes), faz a descoberta on-demand.
     */
    discoveredFks?: FkTableInfo[];
    /** Contexto de auditoria (QUEM/DE ONDE/COMO). Ausente = merge automático em lote. */
    audit?: MergeAuditInput;
  }): Promise<{
    auditId: bigint | number;
    fieldsFilled: string[];
    fieldsMoved: string[];
    rowsReparented: Record<string, number>;
  } | void> {
    const { survivorId, absorbedId, phoneNormalized, category, legalFieldExceptions } = params;
    const audit = params.audit ?? {};

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Reparent de WJA dispara trg_enforce_worker_registered (mig 183/205). Como o
      // principal pode estar INCOMPLETE_REGISTER, o guard abortaria o merge (erro 23514).
      // Merge não é postulação nova → bypassa o guard só nesta transação (mig 229).
      await client.query(`SET LOCAL app.bypass_registered_guard = 'on'`);

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

      // 2. Descobre FKs (usa lista descoberta ou descobre on-demand)
      const fks = params.discoveredFks
        ?? await discoverWorkerFkTables(this.pool, { knownTables: FK_TABLES_TO_REPARENT.map(t => t.table) });

      // 3. SNAPSHOT: captura estado completo do absorvido ANTES de qualquer mutação
      //    (registra primeiro na auditoria para ter o ID disponível). Grava TODO o
      //    rastro: quem, de onde, como (overrides) e os emails das duas contas
      //    (o writer busca os emails das contas internamente).
      const auditId = await insertMergeAuditRow(client, {
        survivorId,
        absorbedId,
        phoneNormalized,
        category,
        legalFieldExceptions,
        audit,
      });

      await captureSnapshot(client, {
        mergeAuditId: auditId,
        absorbedId,
        discoveredFks: fks,
      });

      // 4. COALESCE: preenche campos nulos do sobrevivente com valores do absorvido
      const { fieldsFilled } = await coalesceWorkerFields(client, survivorId, absorbedId);

      // 4b. MOVE de campos de identidade únicos (phone/whatsapp/ana_care_id):
      //     os índices únicos não filtram merged_into_id, então o casco é limpo
      //     ANTES de gravar no sobrevivente, nesta mesma transação.
      const { fieldsMoved } = await moveUniqueIdentityFields(client, survivorId, absorbedId);

      // Atualiza fields_filled/fields_moved no audit agora que temos os valores reais
      await client.query(
        `UPDATE worker_merge_audit
         SET fields_filled = $1::jsonb, fields_moved = $2::jsonb
         WHERE id = $3`,
        [JSON.stringify(fieldsFilled), JSON.stringify(fieldsMoved), auditId],
      );

      // 5. Reparent de todas as tabelas FK, contando linhas movidas por tabela
      //    (só statements que levam linhas AO sobrevivente — alimenta o resumo
      //    "recuperamos N postulações" do vínculo self-service).
      const MOVE_KINDS = ['reparent:update:', 'reparent:1to1_move_if_empty:', 'reparent:Nto1_update:'];
      const rowsReparented: Record<string, number> = {};
      const reparentQueries = buildReparentQueries(survivorId, absorbedId, fks);
      for (const q of reparentQueries) {
        const r = await client.query(q.sql, q.params);
        if (MOVE_KINDS.some(k => q.description.startsWith(k))) {
          const table = q.description.split(':')[2];
          if (table && (r.rowCount ?? 0) > 0) {
            rowsReparented[table] = (rowsReparented[table] ?? 0) + (r.rowCount ?? 0);
          }
        }
      }
      await client.query(
        `UPDATE worker_merge_audit SET rows_reparented = $1::jsonb WHERE id = $2`,
        [JSON.stringify(rowsReparented), auditId],
      );

      // 6. Soft-delete do absorvido
      await client.query(
        `UPDATE workers SET merged_into_id = $1, updated_at = NOW() WHERE id = $2`,
        [survivorId, absorbedId],
      );

      await client.query('COMMIT');

      // AUDIT: log completo (Cloud Logging — fora do alcance de quem mexe no DB).
      log.info({
        msg:          'merge_executed',
        audit_id:     auditId.toString(),
        survivorId,
        absorbedId,
        category,
        fields_filled: fieldsFilled.length,
        fields_moved:  fieldsMoved,
        rows_reparented: rowsReparented,
        fk_tables_reparented: fks.length,
        executed_by:  audit.executedBy ?? 'system',
        executed_by_email: audit.executedByEmail ?? null,
        merge_source: audit.source ?? 'auto_batch',
        confirmed_same_person: audit.confirmedSamePerson ?? false,
        ip_address:   audit.ipAddress ?? null,
        request_id:   audit.requestId ?? null,
        applied_overrides: audit.appliedOverrides ?? [],
      });

      // 7. Recalcula o status do sobrevivente FORA da transação de merge: com o
      //    telefone entrando via move, ele pode virar REGISTERED sem ação do
      //    usuário. Falha aqui não desfaz o merge (já commitado) — só loga.
      try {
        await recalculateWorkerStatus(this.pool, survivorId, null);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        log.warn({ msg: 'merge_status_recalc_failed', survivorId, reason: e.message });
      }

      return { auditId, fieldsFilled, fieldsMoved, rowsReparented };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Desfaz um merge a partir do seu ID de auditoria.
   * Restaura o absorvido ao estado exato pré-merge (snapshot).
   * Idempotente: se já desfeito, retorna sem erros.
   *
   * @param mergeAuditId  ID da linha em worker_merge_audit
   */
  async undoMerge(mergeAuditId: number | bigint, undoAudit?: UndoAuditContext): Promise<{
    survivorId: string;
    absorbedId: string;
    alreadyUndone: boolean;
  }> {
    return undoMergeTx(this.pool, mergeAuditId, undoAudit);
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
