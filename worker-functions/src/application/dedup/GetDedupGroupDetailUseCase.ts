/**
 * GetDedupGroupDetailUseCase
 *
 * Retorna detalhe de um grupo de duplicados: comparação campo-a-campo,
 * preview do que será reparentado, tiers. PII encriptada marcada como
 * "encrypted" — valor cru NUNCA exposto.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { classifyWorkerTier } from '../../infrastructure/services/WorkerPhoneMergeHelpers';
import type {
  DedupMergePreview,
  DedupWorkerAccountDetail,
  FieldComparison,
  ReparentPreview,
} from './DedupTypes';
import { IMPORT_EMAIL_SUFFIX, SYNTHETIC_AUTH_UID_PREFIXES } from '../../infrastructure/services/WorkerPhoneMergeTypes';
import { discoverWorkerFkTables } from '../../infrastructure/services/WorkerPhoneMergeFkDiscovery';

const log = logger.child({ source: 'GetDedupGroupDetailUseCase' });

// Campos encriptados — nunca exibir valor cru
const ENCRYPTED_FIELDS = new Set([
  'first_name_encrypted',
  'last_name_encrypted',
  'sex_encrypted',
  'gender_encrypted',
  'birth_date_encrypted',
  'document_number_encrypted',
  'languages_encrypted',
  'profile_photo_url_encrypted',
  'whatsapp_phone_encrypted',
  'linkedin_url_encrypted',
  'sexual_orientation_encrypted',
  'race_encrypted',
  'religion_encrypted',
  'weight_kg_encrypted',
  'height_cm_encrypted',
]);

// Campos públicos para comparação (não encriptados)
const COMPARE_FIELDS = [
  'profession',
  'knowledge_level',
  'years_experience',
  'status',
  'country',
  'data_sources',
  ...Array.from(ENCRYPTED_FIELDS),
];

export class GetDedupGroupDetailUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(phoneNormalized: string): Promise<DedupMergePreview | null> {
    log.info({ msg: 'get_dedup_group_detail', phoneNormalized });

    // Busca o grupo de colisão
    const collisionRes = await this.pool.query<{ worker_ids: string[] }>(
      `SELECT worker_ids FROM worker_phone_collisions
       WHERE phone_normalized = $1 AND resolved_at IS NULL`,
      [phoneNormalized],
    );

    if (collisionRes.rows.length === 0) return null;
    const workerIds = collisionRes.rows[0].worker_ids;

    // Busca workers ativos com campos para comparação
    const workersRes = await this.pool.query<Record<string, unknown>>(
      `SELECT
         w.id, w.email, w.auth_uid, w.status, w.created_at, w.updated_at,
         w.profession, w.country,
         w.first_name_encrypted, w.last_name_encrypted, w.sex_encrypted,
         w.birth_date_encrypted, w.document_number_encrypted,
         w.languages_encrypted, w.knowledge_level, w.years_experience,
         w.data_sources,
         COALESCE((SELECT COUNT(*)::INT FROM worker_job_applications wja WHERE wja.worker_id = w.id), 0) AS wja_count,
         COALESCE((SELECT COUNT(*)::INT FROM worker_documents wd WHERE wd.worker_id = w.id), 0) AS docs_count,
         COALESCE((SELECT COUNT(*)::INT FROM encuadres e WHERE e.worker_id = w.id), 0) AS encuadres_count
       FROM workers w
       WHERE w.id = ANY($1::uuid[])
         AND w.merged_into_id IS NULL`,
      [workerIds],
    );

    if (workersRes.rows.length === 0) return null;

    const accounts: DedupWorkerAccountDetail[] = workersRes.rows.map(w => ({
      id: String(w.id),
      email: String(w.email),
      tier: classifyWorkerTier({ auth_uid: String(w.auth_uid ?? ''), email: String(w.email) }) as 1 | 2 | 3,
      status: String(w.status),
      created_at: (w.created_at as Date).toISOString(),
      updated_at: (w.updated_at as Date).toISOString(),
      wja_count: Number(w.wja_count),
      docs_count: Number(w.docs_count),
      encuadres_count: Number(w.encuadres_count),
      login_real: !isSyntheticUid(String(w.auth_uid ?? '')) &&
        !String(w.email).toLowerCase().includes(IMPORT_EMAIL_SUFFIX),
      auth_uid_prefix: extractPrefix(String(w.auth_uid ?? '')),
      is_imported: String(w.email).toLowerCase().includes(IMPORT_EMAIL_SUFFIX),
      profession: w.profession != null ? String(w.profession) : null,
      country: w.country != null ? String(w.country) : null,
      has_encrypted_pii: ENCRYPTED_FIELDS_PRESENT(w),
    }));

    const fieldComparisons = buildFieldComparisons(COMPARE_FIELDS, workersRes.rows);

    // Preview de reparent (usa discovery dinâmica)
    const discoveredFks = await discoverWorkerFkTables(this.pool);
    const reparentPreview = await this.buildReparentPreview(workerIds, discoveredFks.map(f => f.table));

    return {
      phone_normalized: phoneNormalized,
      accounts,
      reparent_preview: reparentPreview,
      field_comparison: fieldComparisons,
    };
  }

  private async buildReparentPreview(
    workerIds: string[],
    fkTables: string[],
  ): Promise<ReparentPreview> {
    let wjaTotal = 0;
    let docsTotal = 0;
    let encuadresTotal = 0;
    const otherTables: string[] = [];

    for (const table of fkTables) {
      try {
        const res = await this.pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::INT AS cnt FROM ${table} WHERE worker_id = ANY($1::uuid[])`,
          [workerIds],
        );
        const cnt = Number(res.rows[0]?.cnt ?? 0);
        if (cnt === 0) continue;

        if (table === 'worker_job_applications') wjaTotal += cnt;
        else if (table === 'worker_documents') docsTotal += cnt;
        else if (table === 'encuadres') encuadresTotal += cnt;
        else otherTables.push(`${table}:${cnt}`);
      } catch {
        // Tabela pode não ter coluna worker_id — ignora
      }
    }

    return { wja_total: wjaTotal, docs_total: docsTotal, encuadres_total: encuadresTotal, other_fk_tables: otherTables };
  }
}

function buildFieldComparisons(
  fields: string[],
  rows: Record<string, unknown>[],
): FieldComparison[] {
  if (rows.length < 2) return [];

  const [first, ...rest] = rows;
  return fields.map(field => {
    const firstVal = first[field];
    const otherVals = rest.map(r => r[field]);
    const allVals = [firstVal, ...otherVals];

    const hasAny = allVals.some(v => v != null && v !== '');
    const survivorHas = firstVal != null && firstVal !== '';
    const absorbedHas = otherVals.some(v => v != null && v !== '');

    // Conflito: todos têm valor mas diferem (para encriptado: compara opacamente)
    const nonNull = allVals.filter(v => v != null && v !== '');
    const hasConflict = nonNull.length > 1 && !allVals.every(v => String(v ?? '') === String(firstVal ?? ''));

    return {
      field,
      survivor_has_value: survivorHas,
      absorbed_has_value: absorbedHas,
      is_encrypted: ENCRYPTED_FIELDS.has(field),
      conflict: hasConflict && hasAny,
    };
  });
}

function ENCRYPTED_FIELDS_PRESENT(row: Record<string, unknown>): boolean {
  return Array.from(ENCRYPTED_FIELDS).some(f => row[f] != null);
}

function isSyntheticUid(authUid: string): boolean {
  if (!authUid.trim()) return true;
  return SYNTHETIC_AUTH_UID_PREFIXES.some(p => authUid.startsWith(p));
}

function extractPrefix(authUid: string): string {
  if (!authUid) return 'null';
  const match = SYNTHETIC_AUTH_UID_PREFIXES.find(p => authUid.startsWith(p));
  return match ?? 'real';
}
