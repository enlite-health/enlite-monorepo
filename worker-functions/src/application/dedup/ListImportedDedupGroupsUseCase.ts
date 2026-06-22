/**
 * ListImportedDedupGroupsUseCase
 *
 * Detecta grupos de workers IMPORTADOS duplicados por NOME.
 *
 * Chave de agrupamento: name_trgm_bidx (BYTEA[], HMAC de trigramas do nome).
 * Grupos com igualdade exata do array aproximam nomes idênticos (mig 167).
 *
 * Critérios de inclusão no resultado:
 *   - merged_into_id IS NULL (não mergeados)
 *   - name_trgm_bidx IS NOT NULL (nome indexado)
 *   - COUNT(membros) > 1
 *   - Pelo menos 1 membro com email ILIKE '%@enlite.import'
 *
 * Lógica de survivor sugerido:
 *   - 1 conta real (não-import) → ela é survivor; importado será absorvido
 *   - >1 conta real → conflito (survivor_suggested_id=null)
 *   - 0 conta real → most_complete entre importados
 *
 * Ordenação: grupos com has_real=true primeiro, depois importado-vs-importado.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { classifyWorkerTier, selectMostComplete } from '../../infrastructure/services/WorkerPhoneMergeHelpers';
import type {
  ImportedDedupGroup,
  ImportedDedupWorkerAccount,
  ListImportedDedupGroupsParams,
  WorkerTier,
} from './DedupTypes';
import { IMPORT_EMAIL_SUFFIX, SYNTHETIC_AUTH_UID_PREFIXES } from '../../infrastructure/services/WorkerPhoneMergeTypes';

const log = logger.child({ source: 'ListImportedDedupGroupsUseCase' });

// ── Raw row retornada pelo SELECT ─────────────────────────────────────────

interface RawWorkerRow {
  id: string;
  email: string;
  auth_uid: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  completeness_score: number;
  document_count: number;
  wja_count: number;
  encuadres_count: number;
  document_number_encrypted: string | null;
  data_sources: string[] | null;
  name_trgm_bidx_key: string;
}

// ── Use Case ──────────────────────────────────────────────────────────────

export class ListImportedDedupGroupsUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(params: ListImportedDedupGroupsParams = {}): Promise<ImportedDedupGroup[]> {
    const { onlyWithReal = false } = params;

    log.info({ msg: 'list_imported_dedup_groups_start', onlyWithReal });

    const rows = await this.fetchGroupedWorkers();
    const groups = this.buildGroups(rows, onlyWithReal);

    // Ordenação: has_real=true primeiro
    groups.sort((a, b) => {
      if (a.has_real === b.has_real) return 0;
      return a.has_real ? -1 : 1;
    });

    log.info({
      msg: 'list_imported_dedup_groups_done',
      total: groups.length,
      with_real: groups.filter(g => g.has_real).length,
    });

    return groups;
  }

  // ── Fetch ──────────────────────────────────────────────────────────────

  private async fetchGroupedWorkers(): Promise<RawWorkerRow[]> {
    /**
     * Estratégia: seleciona todos os workers não-mergeados com name_trgm_bidx,
     * serializa o array BYTEA[] como text para usar como chave de agrupamento,
     * filtra só grupos com COUNT > 1 E ao menos 1 importado.
     *
     * A serialização `array_to_string(name_trgm_bidx, ',')` produz uma chave
     * determinística legível para grupos — usada como identificador no response.
     */
    const res = await this.pool.query<RawWorkerRow>(
      `WITH grouped AS (
         SELECT
           array_to_string(w.name_trgm_bidx, ',') AS name_trgm_bidx_key,
           COUNT(*) AS member_count,
           COUNT(*) FILTER (WHERE w.email ILIKE $1) AS import_count
         FROM workers w
         WHERE w.merged_into_id IS NULL
           AND w.name_trgm_bidx IS NOT NULL
         GROUP BY w.name_trgm_bidx
         HAVING COUNT(*) > 1
            AND COUNT(*) FILTER (WHERE w.email ILIKE $1) >= 1
       )
       SELECT
         w.id,
         w.email,
         w.auth_uid,
         w.status,
         w.created_at,
         w.updated_at,
         w.document_number_encrypted,
         w.data_sources,
         g.name_trgm_bidx_key,
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
       JOIN grouped g ON array_to_string(w.name_trgm_bidx, ',') = g.name_trgm_bidx_key
       WHERE w.merged_into_id IS NULL
       ORDER BY g.name_trgm_bidx_key, w.created_at ASC`,
      [`%${IMPORT_EMAIL_SUFFIX}`],
    );

    return res.rows;
  }

  // ── Build groups ───────────────────────────────────────────────────────

  private buildGroups(rows: RawWorkerRow[], onlyWithReal: boolean): ImportedDedupGroup[] {
    // Agrupa por name_trgm_bidx_key
    const byKey = new Map<string, RawWorkerRow[]>();
    for (const row of rows) {
      const list = byKey.get(row.name_trgm_bidx_key) ?? [];
      list.push(row);
      byKey.set(row.name_trgm_bidx_key, list);
    }

    const groups: ImportedDedupGroup[] = [];

    for (const [key, members] of byKey) {
      const hasReal = members.some(m => !isImportedEmail(m.email));

      if (onlyWithReal && !hasReal) continue;

      const accounts = members.map(m => this.toAccount(m));
      const { survivorId, survivorReason } = this.electSurvivor(members);

      groups.push({
        name_trgm_bidx_key: key,
        accounts,
        match_type: 'name',
        confidence: 'name_fuzzy',
        survivor_suggested_id: survivorId,
        survivor_reason: survivorReason,
        has_real: hasReal,
      });
    }

    return groups;
  }

  // ── Account mapping ────────────────────────────────────────────────────

  private toAccount(row: RawWorkerRow): ImportedDedupWorkerAccount {
    return {
      id: row.id,
      email: row.email,
      tier: classifyWorkerTier({ auth_uid: row.auth_uid ?? '', email: row.email }) as WorkerTier,
      status: row.status,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      wja_count: row.wja_count,
      docs_count: row.document_count,
      encuadres_count: row.encuadres_count,
      login_real: !isSyntheticUid(row.auth_uid) && !isImportedEmail(row.email),
      auth_uid_prefix: extractPrefix(row.auth_uid),
      is_imported: isImportedEmail(row.email),
    };
  }

  // ── Survivor election ──────────────────────────────────────────────────

  private electSurvivor(
    members: RawWorkerRow[],
  ): { survivorId: string | null; survivorReason: string } {
    const realMembers = members.filter(m => !isImportedEmail(m.email));
    const importedMembers = members.filter(m => isImportedEmail(m.email));

    // Exatamente 1 conta real → ela é survivor
    if (realMembers.length === 1) {
      return { survivorId: realMembers[0].id, survivorReason: 'real_account_absorbs_imported' };
    }

    // >1 conta real → conflito, revisão humana
    if (realMembers.length > 1) {
      return { survivorId: null, survivorReason: 'conflict_multiple_real_accounts' };
    }

    // 0 conta real → most_complete entre importados
    const best = selectMostComplete(
      importedMembers.map(m => ({
        id: m.id,
        auth_uid: m.auth_uid ?? '',
        email: m.email,
        phone: null,
        phone_normalized: null,
        updated_at: m.updated_at,
        merged_into_id: null,
        completeness_score: m.completeness_score,
        document_count: m.document_count,
        non_null_fields: [],
        document_number_encrypted: m.document_number_encrypted,
        data_sources: m.data_sources,
      })),
    );

    return { survivorId: best.id, survivorReason: 'most_complete_imported' };
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

function isImportedEmail(email: string): boolean {
  return email.toLowerCase().includes(IMPORT_EMAIL_SUFFIX);
}

function isSyntheticUid(authUid: string | null | undefined): boolean {
  if (!authUid || authUid.trim() === '') return true;
  return SYNTHETIC_AUTH_UID_PREFIXES.some(prefix => authUid.startsWith(prefix));
}

function extractPrefix(authUid: string | null | undefined): string {
  if (!authUid) return 'null';
  const match = SYNTHETIC_AUTH_UID_PREFIXES.find(p => authUid.startsWith(p));
  return match ?? 'real';
}
