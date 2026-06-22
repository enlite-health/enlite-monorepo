/**
 * ExecuteAdminMergeUseCase
 *
 * Executa 1 merge iniciado manualmente pelo admin via endpoint POST /api/admin/dedup/merge.
 * Suporta fieldChoices para modo avançado (admin escolhe valor campo a campo).
 * Captura snapshot pré-merge para permitir undo.
 */

import type { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { WorkerPhoneMergeService } from '../../infrastructure/services/WorkerPhoneMergeService';
import { discoverWorkerFkTables } from '../../infrastructure/services/WorkerPhoneMergeFkDiscovery';
import { FK_TABLES_TO_REPARENT } from '../../infrastructure/services/WorkerPhoneMergeTypes';
import type { AdminMergeResult, ExecuteMergeParams } from './DedupTypes';

const log = logger.child({ source: 'ExecuteAdminMergeUseCase' });

export class ExecuteAdminMergeUseCase {
  private readonly mergeService: WorkerPhoneMergeService;

  constructor(private readonly pool: Pool) {
    this.mergeService = new WorkerPhoneMergeService();
  }

  async execute(params: ExecuteMergeParams): Promise<AdminMergeResult> {
    const { survivorId, absorbedIds, fieldChoices } = params;

    log.info({
      msg: 'admin_merge_start',
      survivorId,
      absorbedIds,
      has_field_choices: Boolean(fieldChoices && Object.keys(fieldChoices).length > 0),
    });

    // Valida que survivorId existe e não está mergeado
    const survivorRes = await this.pool.query<{ id: string; phone_normalized: string; merged_into_id: string | null }>(
      `SELECT id, phone_normalized, merged_into_id FROM workers WHERE id = $1::uuid`,
      [survivorId],
    );

    if (survivorRes.rows.length === 0) {
      throw new Error(`Survivor worker não encontrado: ${survivorId}`);
    }

    const survivor = survivorRes.rows[0];
    if (survivor.merged_into_id != null) {
      throw new Error(`Survivor ${survivorId} já foi mergeado (merged_into_id = ${survivor.merged_into_id})`);
    }

    const phoneNormalized = survivor.phone_normalized ?? '';

    // Descobre FKs uma vez
    const discoveredFks = await discoverWorkerFkTables(this.pool, {
      knownTables: FK_TABLES_TO_REPARENT.map(t => t.table),
    });

    const auditIds: number[] = [];

    for (const absorbedId of absorbedIds) {
      // Valida absorvido
      const absRes = await this.pool.query<{ merged_into_id: string | null }>(
        `SELECT merged_into_id FROM workers WHERE id = $1::uuid`,
        [absorbedId],
      );

      if (absRes.rows.length === 0) {
        log.warn({ msg: 'admin_merge_absorbed_not_found', absorbedId });
        continue;
      }

      if (absRes.rows[0].merged_into_id != null) {
        log.info({ msg: 'admin_merge_absorbed_already_merged', absorbedId });
        continue;
      }

      try {
        // Se fieldChoices fornecido, aplica overrides antes do merge
        if (fieldChoices && Object.keys(fieldChoices).length > 0) {
          await this.applyFieldChoices(survivorId, absorbedId, fieldChoices);
        }

        await this.mergeService.executeSingleMerge({
          survivorId,
          absorbedId,
          phoneNormalized,
          category: 'firebase', // Admin merge assume categoria mais permissiva
          legalFieldExceptions: [],
          discoveredFks,
        });

        // Recupera o auditId do último merge inserido
        const auditRes = await this.pool.query<{ id: number }>(
          `SELECT id FROM worker_merge_audit
           WHERE survivor_id = $1::uuid AND absorbed_id = $2::uuid
           ORDER BY created_at DESC LIMIT 1`,
          [survivorId, absorbedId],
        );

        if (auditRes.rows.length > 0) {
          auditIds.push(Number(auditRes.rows[0].id));
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        reportError(e, { source: 'ExecuteAdminMergeUseCase', survivorId, absorbedId });
        throw e;
      }
    }

    log.info({
      msg: 'admin_merge_done',
      survivorId,
      absorbed_count: absorbedIds.length,
      audit_ids: auditIds,
    });

    return { audit_ids: auditIds, survivor_id: survivorId, absorbed_ids: absorbedIds };
  }

  /**
   * Aplica field choices do modo avançado: copia valor do absorvido para o survivor
   * apenas para os campos onde fieldChoices[campo] === 'absorbed:<absorbedId>'.
   *
   * NUNCA sobrescreve campos encriptados com valor cru — aceita apenas a chave do choice.
   */
  private async applyFieldChoices(
    survivorId: string,
    absorbedId: string,
    fieldChoices: Record<string, string>,
  ): Promise<void> {
    // Campos que podem ser sobrescritos via choice (não encriptados e não críticos)
    const OVERRIDABLE_FIELDS = new Set([
      'profession',
      'knowledge_level',
      'years_experience',
      'status',
    ]);

    const overrideFields: string[] = [];
    for (const [field, choice] of Object.entries(fieldChoices)) {
      if (!OVERRIDABLE_FIELDS.has(field)) continue;
      if (choice === `absorbed:${absorbedId}`) {
        overrideFields.push(field);
      }
    }

    if (overrideFields.length === 0) return;

    // Busca valores do absorvido para os campos escolhidos
    const absRes = await this.pool.query<Record<string, unknown>>(
      `SELECT ${overrideFields.join(', ')} FROM workers WHERE id = $1::uuid`,
      [absorbedId],
    );

    if (absRes.rows.length === 0) return;

    const absorbedRow = absRes.rows[0];
    const setClauses = overrideFields.map((f, i) => `${f} = $${i + 1}`);
    const values = [...overrideFields.map(f => absorbedRow[f]), survivorId];

    await this.pool.query(
      `UPDATE workers SET ${setClauses.join(', ')} WHERE id = $${overrideFields.length + 1}::uuid`,
      values,
    );

    log.info({ msg: 'field_choices_applied', survivorId, fields: overrideFields });
  }
}
