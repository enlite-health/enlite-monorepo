/**
 * BuildManualDedupGroupUseCase
 *
 * Monta um grupo de dedup ad-hoc a partir de IDs escolhidos pelo operador.
 * Usado pelo Centro de Duplicados — aba "Merge Manual".
 *
 * Validações:
 *   - 2 a 5 IDs
 *   - Todos existem na tabela workers
 *   - Nenhum tem merged_into_id IS NOT NULL (já absorvido)
 *
 * Monta o grupo no mesmo shape que a aba Importados consome
 * (ImportedDedupWorkerAccount + name decriptado + phone_normalized),
 * reutilizando electSurvivor e toImportedAccount de dedupGroupBuilder.
 *
 * Inclui field_comparisons (comparação campo-a-campo via dedupFieldComparison)
 * para exibição do chooser "Avanzado" na UI — mesmo padrão do GetDedupGroupDetail.
 *
 * O merge em si é feito pelo endpoint existente POST /api/admin/dedup/merge.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { loadWorkerDisplayNames } from './loadWorkerDisplayNames';
import {
  type BuilderWorkerRow,
  electSurvivor,
  toImportedAccount,
} from './dedupGroupBuilder';
import type { FieldComparison, ImportedDedupWorkerAccount } from './DedupTypes';
import {
  COMPARE_FIELDS,
  buildFieldComparisons,
} from './dedupFieldComparison';

const log = logger.child({ source: 'BuildManualDedupGroupUseCase' });

// ── Tipos públicos ─────────────────────────────────────────────────────────

/** Conta no grupo manual — inclui nome decriptado e phone_normalized */
export type ManualDedupAccount = ImportedDedupWorkerAccount & {
  name: string;
  phone_normalized: string | null;
};

export interface ManualDedupGroupResult {
  accounts: ManualDedupAccount[];
  survivor_suggested_id: string | null;
  survivor_reason: string;
  /** Comparação campo-a-campo das contas escolhidas (chooser "Avanzado"). */
  field_comparisons: FieldComparison[];
}

// ── Erros de domínio ──────────────────────────────────────────────────────

export class ManualDedupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualDedupValidationError';
  }
}

// ── Raw DB row ─────────────────────────────────────────────────────────────

/**
 * Estende BuilderWorkerRow com merged_into_id (validação) e todos os campos
 * de COMPARE_FIELDS necessários para buildFieldComparisons.
 */
interface WorkerRow extends BuilderWorkerRow {
  merged_into_id: string | null;
  // Campos de COMPARE_FIELDS não cobertos por BuilderWorkerRow
  profession: string | null;
  knowledge_level: string | null;
  years_experience: number | null;
  status: string;
  country: string | null;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  sex_encrypted: string | null;
  gender_encrypted: string | null;
  birth_date_encrypted: string | null;
  languages_encrypted: string | null;
  profile_photo_url_encrypted: string | null;
  whatsapp_phone_encrypted: string | null;
  linkedin_url_encrypted: string | null;
  sexual_orientation_encrypted: string | null;
  race_encrypted: string | null;
  religion_encrypted: string | null;
  weight_kg_encrypted: string | null;
  height_cm_encrypted: string | null;
}

// ── Use case ───────────────────────────────────────────────────────────────

export class BuildManualDedupGroupUseCase {
  private readonly encryptionService: KMSEncryptionService;

  constructor(
    private readonly pool: Pool,
    encryptionService?: KMSEncryptionService,
  ) {
    this.encryptionService = encryptionService ?? new KMSEncryptionService();
  }

  async execute(ids: string[]): Promise<ManualDedupGroupResult> {
    log.info({ msg: 'build_manual_dedup_group_start', count: ids.length });

    const rows = await this.fetchWorkers(ids);

    this.validate(ids, rows);

    const nameMap = await loadWorkerDisplayNames(this.pool, ids, this.encryptionService);

    const accounts: ManualDedupAccount[] = rows.map(row => ({
      ...toImportedAccount(row),
      name: nameMap.get(row.id) ?? '(sin nombre)',
    }));

    const { survivorId, survivorReason } = electSurvivor(rows);

    // Comparação campo-a-campo — mesmo padrão do GetDedupGroupDetail.
    // rows já contém todas as colunas de COMPARE_FIELDS (inclusive *_encrypted).
    const fieldComparisons = await buildFieldComparisons(
      COMPARE_FIELDS,
      rows as unknown as Record<string, unknown>[],
      this.encryptionService,
    );

    log.info({
      msg: 'build_manual_dedup_group_done',
      survivorId,
      survivorReason,
      field_comparisons_count: fieldComparisons.length,
    });

    return {
      accounts,
      survivor_suggested_id: survivorId,
      survivor_reason: survivorReason,
      field_comparisons: fieldComparisons,
    };
  }

  // ── Fetch ──────────────────────────────────────────────────────────────

  private async fetchWorkers(ids: string[]): Promise<WorkerRow[]> {
    const res = await this.pool.query<WorkerRow>(
      `SELECT
         w.id,
         w.email,
         w.auth_uid,
         w.status,
         w.created_at,
         w.updated_at,
         w.phone_normalized,
         w.merged_into_id,
         -- Campos de COMPARE_FIELDS (não encriptados)
         w.profession,
         w.knowledge_level,
         w.years_experience,
         w.country,
         w.data_sources,
         -- Campos de COMPARE_FIELDS (encriptados KMS)
         w.document_number_encrypted,
         w.first_name_encrypted,
         w.last_name_encrypted,
         w.sex_encrypted,
         w.gender_encrypted,
         w.birth_date_encrypted,
         w.languages_encrypted,
         w.profile_photo_url_encrypted,
         w.whatsapp_phone_encrypted,
         w.linkedin_url_encrypted,
         w.sexual_orientation_encrypted,
         w.race_encrypted,
         w.religion_encrypted,
         w.weight_kg_encrypted,
         w.height_cm_encrypted,
         -- Campos para electSurvivor / completeness
         (
           (CASE WHEN w.first_name_encrypted      IS NOT NULL THEN 1 ELSE 0 END) +
           (CASE WHEN w.last_name_encrypted        IS NOT NULL THEN 1 ELSE 0 END) +
           (CASE WHEN w.document_number_encrypted  IS NOT NULL THEN 1 ELSE 0 END) +
           (CASE WHEN w.profession                 IS NOT NULL THEN 1 ELSE 0 END) +
           (CASE WHEN w.languages_encrypted        IS NOT NULL THEN 1 ELSE 0 END)
         )::INT AS completeness_score,
         COALESCE((
           SELECT COUNT(*)::INT FROM worker_documents wd WHERE wd.worker_id = w.id
         ), 0) AS document_count,
         COALESCE((
           SELECT COUNT(*)::INT FROM worker_job_applications wja WHERE wja.worker_id = w.id
         ), 0) AS wja_count,
         COALESCE((
           SELECT COUNT(*)::INT FROM encuadres e WHERE e.worker_id = w.id
         ), 0) AS encuadres_count
       FROM workers w
       WHERE w.id = ANY($1::uuid[])`,
      [ids],
    );
    return res.rows;
  }

  // ── Validação ──────────────────────────────────────────────────────────

  private validate(requestedIds: string[], rows: WorkerRow[]): void {
    // Verifica se todos os IDs existem
    const foundIds = new Set(rows.map(r => r.id));
    const missing = requestedIds.filter(id => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ManualDedupValidationError(
        `Workers não encontrados: ${missing.join(', ')}`,
      );
    }

    // Verifica se algum já foi absorvido
    const alreadyMerged = rows.filter(r => r.merged_into_id != null);
    if (alreadyMerged.length > 0) {
      throw new ManualDedupValidationError(
        `Workers já absorvidos por outro merge: ${alreadyMerged.map(r => r.id).join(', ')}`,
      );
    }
  }
}
