/**
 * GetDedupGroupDetailUseCase
 *
 * Retorna detalhe de um grupo de duplicados: comparação campo-a-campo,
 * preview do que será reparentado, tiers.
 *
 * PII encriptada: como o endpoint é admin-only (requireAdmin em dedupRoutes) e
 * o admin já vê esse mesmo PII na ficha do prestador (/admin/workers/:id), aqui
 * o valor é DECRIPTADO via KMS — sem isso o admin não consegue comparar contas
 * pra escolher a sobrevivente. `is_encrypted` continua true (a UI usa só como
 * sinal "dado sensível", agora COM valor). Decriptação reusa o mesmo
 * KMSEncryptionService da ficha (AdminWorkersDetailBuilder.decrypt).
 *
 * Funções de comparação campo-a-campo extraídas para dedupFieldComparison.ts
 * (compartilhado com BuildManualDedupGroupUseCase).
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { classifyWorkerTier } from '../../infrastructure/services/WorkerPhoneMergeHelpers';
import type {
  DedupMergePreview,
  DedupWorkerAccountDetail,
  ReparentPreview,
} from './DedupTypes';
import { suggestSurvivorId } from './suggestSurvivorId';
import { IMPORT_EMAIL_SUFFIX, SYNTHETIC_AUTH_UID_PREFIXES } from '../../infrastructure/services/WorkerPhoneMergeTypes';
import { discoverWorkerFkTables } from '../../infrastructure/services/WorkerPhoneMergeFkDiscovery';
import {
  COMPARE_FIELDS,
  ENCRYPTED_FIELDS,
  ENCRYPTED_FIELDS_PRESENT,
  buildFieldComparisons,
} from './dedupFieldComparison';

const log = logger.child({ source: 'GetDedupGroupDetailUseCase' });

export class GetDedupGroupDetailUseCase {
  private readonly encryptionService: KMSEncryptionService;

  constructor(
    private readonly pool: Pool,
    encryptionService?: KMSEncryptionService,
  ) {
    // Reusa o mesmo serviço da ficha do prestador (KMS / test-passthrough).
    this.encryptionService = encryptionService ?? new KMSEncryptionService();
  }

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
         w.gender_encrypted,
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

    const fieldComparisons = await buildFieldComparisons(
      COMPARE_FIELDS,
      workersRes.rows,
      this.encryptionService,
    );

    // Preview de reparent (usa discovery dinâmica)
    const discoveredFks = await discoverWorkerFkTables(this.pool);
    const reparentPreview = await this.buildReparentPreview(workerIds, discoveredFks.map(f => f.table));

    // Sobrevivente sugerido: tier logic. Fallback p/ 1ª conta (nunca undefined — evita
    // crash silencioso no frontend que setava survivorId=undefined).
    const survivorSuggested = suggestSurvivorId(accounts);

    return {
      phone_normalized: phoneNormalized,
      accounts,
      survivor_suggested: survivorSuggested,
      reparent_preview: reparentPreview,
      field_comparisons: fieldComparisons,
    };
  }

  private async buildReparentPreview(
    workerIds: string[],
    fkTables: string[],
  ): Promise<ReparentPreview[]> {
    const preview: ReparentPreview[] = [];

    for (const table of fkTables) {
      try {
        const res = await this.pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::INT AS cnt FROM ${table} WHERE worker_id = ANY($1::uuid[])`,
          [workerIds],
        );
        const cnt = Number(res.rows[0]?.cnt ?? 0);
        if (cnt === 0) continue;
        preview.push({ entity: table, count: cnt });
      } catch {
        // Tabela pode não ter coluna worker_id — ignora
      }
    }

    return preview;
  }
}

// ── Helpers de tier/prefix (privados a este módulo) ─────────────────────────

function isSyntheticUid(authUid: string): boolean {
  if (!authUid.trim()) return true;
  return SYNTHETIC_AUTH_UID_PREFIXES.some(p => authUid.startsWith(p));
}

function extractPrefix(authUid: string): string {
  if (!authUid) return 'null';
  const match = SYNTHETIC_AUTH_UID_PREFIXES.find(p => authUid.startsWith(p));
  return match ?? 'real';
}

// Re-exporta apenas o que os testes de GetDedupGroupDetail precisam internamente.
// A lógica de comparação vive em dedupFieldComparison.ts (SSOT).
export { ENCRYPTED_FIELDS, COMPARE_FIELDS };
