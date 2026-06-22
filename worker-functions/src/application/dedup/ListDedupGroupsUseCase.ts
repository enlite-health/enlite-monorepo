/**
 * ListDedupGroupsUseCase
 *
 * Lista grupos de phone_normalized com duplicados não resolvidos e não dispensados.
 * Para cada grupo, retorna as contas com counts de WJA, docs, encuadres,
 * tier de confiança e survivor sugerido pela tier logic.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { classifyWorkerTier } from '../../infrastructure/services/WorkerPhoneMergeHelpers';
import { selectMostComplete } from '../../infrastructure/services/WorkerPhoneMergeHelpers';
import type { DedupGroup, DedupWorkerAccount, WorkerTier } from './DedupTypes';
import { SYNTHETIC_AUTH_UID_PREFIXES, IMPORT_EMAIL_SUFFIX } from '../../infrastructure/services/WorkerPhoneMergeTypes';

const log = logger.child({ source: 'ListDedupGroupsUseCase' });

interface RawWorkerRow {
  id: string;
  email: string;
  auth_uid: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  completeness_score: number;
  document_count: number;
  wja_count: number;
  encuadres_count: number;
  document_number_encrypted: string | null;
  data_sources: string[] | null;
}

export class ListDedupGroupsUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(): Promise<DedupGroup[]> {
    log.info({ msg: 'list_dedup_groups_start' });

    // Busca grupos de colisão não resolvidos E não dispensados
    const collisionRes = await this.pool.query<{
      phone_normalized: string;
      worker_ids: string[];
    }>(
      `SELECT wpc.phone_normalized, wpc.worker_ids
       FROM worker_phone_collisions wpc
       WHERE wpc.resolved_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM dedup_dismissed dd
           WHERE dd.phone_normalized = wpc.phone_normalized
         )
       ORDER BY wpc.worker_count DESC`,
    );

    const groups: DedupGroup[] = [];

    for (const row of collisionRes.rows) {
      // Filtra apenas workers ainda ativos (sem merged_into_id)
      const workers = await this.fetchWorkers(row.worker_ids);
      const active = workers.filter(w => true); // already filtered by query below

      if (active.length <= 1) continue;

      const group = this.buildGroup(row.phone_normalized, active);
      groups.push(group);
    }

    log.info({ msg: 'list_dedup_groups_done', total: groups.length });
    return groups;
  }

  private async fetchWorkers(workerIds: string[]): Promise<RawWorkerRow[]> {
    const res = await this.pool.query<RawWorkerRow>(
      `SELECT
         w.id,
         w.email,
         w.auth_uid,
         w.status,
         w.created_at,
         w.updated_at,
         w.document_number_encrypted,
         w.data_sources,
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
       WHERE w.id = ANY($1::uuid[])
         AND w.merged_into_id IS NULL`,
      [workerIds],
    );
    return res.rows;
  }

  private buildGroup(phoneNormalized: string, workers: RawWorkerRow[]): DedupGroup {
    const accounts: DedupWorkerAccount[] = workers.map(w => ({
      id: w.id,
      email: w.email,
      tier: classifyWorkerTier({ auth_uid: w.auth_uid, email: w.email }) as WorkerTier,
      status: w.status,
      created_at: w.created_at.toISOString(),
      updated_at: w.updated_at.toISOString(),
      wja_count: w.wja_count,
      docs_count: w.document_count,
      encuadres_count: w.encuadres_count,
      login_real: !isSyntheticUid(w.auth_uid) && !w.email.toLowerCase().includes(IMPORT_EMAIL_SUFFIX),
      auth_uid_prefix: extractPrefix(w.auth_uid),
      is_imported: w.email.toLowerCase().includes(IMPORT_EMAIL_SUFFIX),
    }));

    // Determina survivor sugerido
    const tier1 = workers.filter(w => classifyWorkerTier({ auth_uid: w.auth_uid, email: w.email }) === 1);
    const tier2 = workers.filter(w => classifyWorkerTier({ auth_uid: w.auth_uid, email: w.email }) === 2);

    let survivorId: string | null = null;
    let survivorReason = '';

    if (tier1.length === 1) {
      survivorId = tier1[0].id;
      survivorReason = 'tier1_real_human';
    } else if (tier1.length > 1) {
      survivorId = null;
      survivorReason = 'conflict_multiple_tier1';
    } else if (tier2.length > 0) {
      const best = selectMostComplete(tier2.map(w => ({
        id: w.id,
        auth_uid: w.auth_uid,
        email: w.email,
        phone: null,
        phone_normalized: null,
        updated_at: w.updated_at,
        merged_into_id: null,
        completeness_score: w.completeness_score,
        document_count: w.document_count,
        non_null_fields: [],
        document_number_encrypted: w.document_number_encrypted,
        data_sources: w.data_sources,
      })));
      survivorId = best.id;
      survivorReason = 'most_complete_tier2';
    } else {
      const best = selectMostComplete(workers.map(w => ({
        id: w.id,
        auth_uid: w.auth_uid,
        email: w.email,
        phone: null,
        phone_normalized: null,
        updated_at: w.updated_at,
        merged_into_id: null,
        completeness_score: w.completeness_score,
        document_count: w.document_count,
        non_null_fields: [],
        document_number_encrypted: w.document_number_encrypted,
        data_sources: w.data_sources,
      })));
      survivorId = best.id;
      survivorReason = 'most_complete_tier3';
    }

    return { phone_normalized: phoneNormalized, accounts, survivor_suggested_id: survivorId, survivor_reason: survivorReason };
  }
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
