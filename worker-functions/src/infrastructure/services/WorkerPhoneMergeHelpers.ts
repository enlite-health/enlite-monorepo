/**
 * WorkerPhoneMergeHelpers
 *
 * Funções puras e helpers de banco de dados para WorkerPhoneMergeService.
 * Separado para manter cada arquivo ≤ 400 linhas.
 *
 * Conteúdo:
 *   - isFirebaseRealUid          → detecta UID sintético vs real
 *   - fetchWorkersById           → busca workers com score de completude
 *   - selectMostComplete         → elege sobrevivente por completude
 *   - detectLegalFieldExceptions → campos legais divergentes
 *   - buildGroupPlans            → plano de merge por grupo de colisão
 *   - resolveGhosts              → ghost reconciliation
 *   - coalesceWorkerFields       → COALESCE de campos no banco
 *
 * Reparent de FK: ver WorkerPhoneMergeReparent.ts
 */

import { Pool, PoolClient } from 'pg';
import {
  type WorkerInGroup,
  type WorkerTier,
  type MergeGroupPlan,
  type GhostMatchPlan,
  type GhostOrphan,
  type LegalFieldException,
  SYNTHETIC_AUTH_UID_PREFIXES,
  IMPORT_EMAIL_SUFFIX,
} from './WorkerPhoneMergeTypes';

// Re-exporta para que WorkerPhoneMergeService importe de um único lugar
export { buildReparentQueries } from './WorkerPhoneMergeReparent';
export type { ReparentQuery } from './WorkerPhoneMergeReparent';
export { discoverWorkerFkTables } from './WorkerPhoneMergeFkDiscovery';
export type { FkTableInfo } from './WorkerPhoneMergeFkDiscovery';

// ─── Classificação por tier ───────────────────────────────────────────────

/**
 * Retorna true se auth_uid é sintético (não-Firebase real).
 * UID sintético começa com um dos prefixos canônicos de import.
 */
function isSyntheticUid(authUid: string | null | undefined): boolean {
  if (!authUid || authUid.trim() === '') return true;
  return SYNTHETIC_AUTH_UID_PREFIXES.some(prefix => authUid.startsWith(prefix));
}

/**
 * Classifica um worker em tier para eleição de sobrevivente:
 *
 *   TIER 1 — humano real:        auth_uid não-sintético E email sem @enlite.import
 *   TIER 2 — claimed sem email:  auth_uid não-sintético MAS email @enlite.import
 *   TIER 3 — ghost/import:       auth_uid sintético (qualquer email)
 *
 * Sobrevivente do grupo = maior tier. CONFLICT = ≥2 TIER 1 no grupo.
 */
export function classifyWorkerTier(worker: Pick<WorkerInGroup, 'auth_uid' | 'email'>): WorkerTier {
  if (isSyntheticUid(worker.auth_uid)) return 3;
  if (worker.email.toLowerCase().includes(IMPORT_EMAIL_SUFFIX)) return 2;
  return 1;
}

/**
 * Mantido para compatibilidade com código legado.
 * @deprecated Use classifyWorkerTier e compare com tier === 1.
 */
export function isFirebaseRealUid(authUid: string | null | undefined): boolean {
  return !isSyntheticUid(authUid);
}

// ─── Busca de workers por IDs ──────────────────────────────────────────────

export async function fetchWorkersById(
  pool: Pool,
  workerIds: string[],
): Promise<WorkerInGroup[]> {
  if (workerIds.length === 0) return [];

  const result = await pool.query<WorkerInGroup>(
    `SELECT
       w.id,
       w.auth_uid,
       w.email,
       w.phone,
       w.phone_normalized,
       w.updated_at,
       w.merged_into_id,
       w.document_number_encrypted,
       w.data_sources,
       (
         (CASE WHEN w.first_name_encrypted      IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.last_name_encrypted       IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.sex_encrypted             IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.birth_date_encrypted      IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.document_number_encrypted IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.languages_encrypted       IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.phone                     IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.profession                IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.knowledge_level           IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN w.years_experience          IS NOT NULL THEN 1 ELSE 0 END)
       )::INT AS completeness_score,
       COALESCE((
         SELECT COUNT(*)::INT FROM worker_documents wd WHERE wd.worker_id = w.id
       ), 0) AS document_count,
       ARRAY_REMOVE(ARRAY[
         CASE WHEN w.first_name_encrypted      IS NOT NULL THEN 'first_name_encrypted'      END,
         CASE WHEN w.last_name_encrypted       IS NOT NULL THEN 'last_name_encrypted'       END,
         CASE WHEN w.sex_encrypted             IS NOT NULL THEN 'sex_encrypted'             END,
         CASE WHEN w.gender_encrypted          IS NOT NULL THEN 'gender_encrypted'          END,
         CASE WHEN w.birth_date_encrypted      IS NOT NULL THEN 'birth_date_encrypted'      END,
         CASE WHEN w.document_number_encrypted IS NOT NULL THEN 'document_number_encrypted' END,
         CASE WHEN w.languages_encrypted       IS NOT NULL THEN 'languages_encrypted'       END,
         CASE WHEN w.profession                IS NOT NULL THEN 'profession'                END,
         CASE WHEN w.knowledge_level           IS NOT NULL THEN 'knowledge_level'           END,
         CASE WHEN w.years_experience          IS NOT NULL THEN 'years_experience'          END,
         CASE WHEN w.preferred_types           IS NOT NULL THEN 'preferred_types'           END,
         CASE WHEN w.preferred_age_range       IS NOT NULL THEN 'preferred_age_range'       END
       ], NULL) AS non_null_fields
     FROM workers w
     WHERE w.id = ANY($1::uuid[])
       AND w.merged_into_id IS NULL`,
    [workerIds],
  );

  return result.rows;
}

// ─── Seleção do sobrevivente (most_complete) ───────────────────────────────

/**
 * Elege sobrevivente quando 0 Firebase real.
 * Critério: completeness_score DESC → document_count DESC → updated_at DESC.
 */
export function selectMostComplete(workers: WorkerInGroup[]): WorkerInGroup {
  return workers.slice().sort((a, b) => {
    const byScore = b.completeness_score - a.completeness_score;
    if (byScore !== 0) return byScore;
    const byDocs = b.document_count - a.document_count;
    if (byDocs !== 0) return byDocs;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  })[0];
}

// ─── Campos legais divergentes ─────────────────────────────────────────────

/**
 * Compara document_number_encrypted entre sobrevivente e absorvido.
 * Exceção apenas quando AMBOS são não-nulos E diferentes (COALESCE não é seguro).
 */
export function detectLegalFieldExceptions(
  survivor: WorkerInGroup,
  absorbed: WorkerInGroup,
): LegalFieldException[] {
  const exceptions: LegalFieldException[] = [];
  const sv = survivor.document_number_encrypted;
  const ab = absorbed.document_number_encrypted;

  if (sv != null && ab != null && sv !== ab) {
    exceptions.push({
      field: 'document_number_encrypted',
      survivor_value_hash: sv.slice(0, 8) + '...',
      absorbed_value_hash: ab.slice(0, 8) + '...',
      reason: 'divergent_values_both_non_null',
    });
  }

  return exceptions;
}

// ─── Planos por grupo de colisão ───────────────────────────────────────────

export async function buildGroupPlans(
  collisionGroups: Array<{ phone_normalized: string; worker_ids: string[] }>,
  pool: Pool,
): Promise<MergeGroupPlan[]> {
  const plans: MergeGroupPlan[] = [];

  for (const group of collisionGroups) {
    const workers = await fetchWorkersById(pool, group.worker_ids);
    const active = workers.filter(w => w.merged_into_id === null);

    if (active.length <= 1) {
      plans.push({
        phone_normalized: group.phone_normalized,
        category: 'skip',
        worker_ids: group.worker_ids,
        survivor_id: active[0]?.id ?? null,
        absorbed_ids: [],
        legal_field_exceptions: [],
        survivor_reason: 'already_resolved_only_one_active',
      });
      continue;
    }

    const tier1 = active.filter(w => classifyWorkerTier(w) === 1);

    // CONFLICT: ≥2 humanos reais (TIER 1) — revisão humana obrigatória
    if (tier1.length >= 2) {
      plans.push({
        phone_normalized: group.phone_normalized,
        category: 'conflict',
        worker_ids: active.map(w => w.id),
        survivor_id: null,
        absorbed_ids: [],
        legal_field_exceptions: [],
        survivor_reason: `conflict:${tier1.length}_tier1_real_humans`,
      });
      continue;
    }

    // Exatamente 1 TIER 1 → ele é o sobrevivente (categoria: firebase)
    if (tier1.length === 1) {
      const survivor = tier1[0];
      const absorbed = active.filter(w => w.id !== survivor.id);
      plans.push({
        phone_normalized: group.phone_normalized,
        category: 'firebase',
        worker_ids: active.map(w => w.id),
        survivor_id: survivor.id,
        absorbed_ids: absorbed.map(w => w.id),
        legal_field_exceptions: absorbed.flatMap(a => detectLegalFieldExceptions(survivor, a)),
        survivor_reason: `tier1_real_uid:${survivor.auth_uid}`,
      });
      continue;
    }

    // 0 TIER 1 → elege por completude entre TIER 2 e TIER 3 (categoria: most_complete)
    {
      const survivor = selectMostComplete(active);
      const absorbed = active.filter(w => w.id !== survivor.id);
      plans.push({
        phone_normalized: group.phone_normalized,
        category: 'most_complete',
        worker_ids: active.map(w => w.id),
        survivor_id: survivor.id,
        absorbed_ids: absorbed.map(w => w.id),
        legal_field_exceptions: absorbed.flatMap(a => detectLegalFieldExceptions(survivor, a)),
        survivor_reason: `most_complete:score=${survivor.completeness_score}:docs=${survivor.document_count}`,
      });
    }
  }

  return plans;
}

// ─── Ghost reconciliation ──────────────────────────────────────────────────

export async function resolveGhosts(
  pool: Pool,
): Promise<{ ghostMatches: GhostMatchPlan[]; ghostOrphans: GhostOrphan[] }> {
  const ghostsResult = await pool.query<{
    id: string;
    email: string;
    phone: string | null;
    phone_normalized: string | null;
  }>(
    `SELECT id, email, phone, phone_normalized
     FROM workers
     WHERE email LIKE '%@enlite.import'
       AND merged_into_id IS NULL
     ORDER BY created_at ASC`,
  );

  const ghostMatches: GhostMatchPlan[] = [];
  const ghostOrphans: GhostOrphan[] = [];

  for (const ghost of ghostsResult.rows) {
    if (!ghost.phone_normalized) {
      ghostOrphans.push({
        worker_id: ghost.id,
        email: ghost.email,
        phone: ghost.phone,
        phone_normalized: ghost.phone_normalized,
        reason: 'no_phone',
      });
      continue;
    }

    const realResult = await pool.query<{ id: string; email: string }>(
      `SELECT id, email
       FROM workers
       WHERE phone_normalized = $1
         AND email NOT LIKE '%@enlite.import'
         AND merged_into_id IS NULL
       ORDER BY updated_at DESC
       LIMIT 1`,
      [ghost.phone_normalized],
    );

    if (realResult.rows.length > 0) {
      const real = realResult.rows[0];
      ghostMatches.push({
        ghost_id: ghost.id,
        real_id: real.id,
        phone_normalized: ghost.phone_normalized,
        ghost_email: ghost.email,
        real_email: real.email,
      });
    } else {
      ghostOrphans.push({
        worker_id: ghost.id,
        email: ghost.email,
        phone: ghost.phone,
        phone_normalized: ghost.phone_normalized,
        reason: 'no_real_match',
      });
    }
  }

  return { ghostMatches, ghostOrphans };
}

// ─── COALESCE de campos do worker ─────────────────────────────────────────

/**
 * Preenche campos nulos do sobrevivente com valores do absorvido.
 * Retorna lista de campos que foram efetivamente preenchidos.
 * NUNCA sobrescreve campos não-nulos do sobrevivente.
 */
export async function coalesceWorkerFields(
  client: PoolClient,
  survivorId: string,
  absorbedId: string,
): Promise<{ fieldsFilled: string[] }> {
  await client.query(
    `UPDATE workers survivor
     SET
       first_name_encrypted      = COALESCE(survivor.first_name_encrypted,  absorbed.first_name_encrypted),
       last_name_encrypted       = COALESCE(survivor.last_name_encrypted,   absorbed.last_name_encrypted),
       sex_encrypted             = COALESCE(survivor.sex_encrypted,         absorbed.sex_encrypted),
       gender_encrypted          = COALESCE(survivor.gender_encrypted,      absorbed.gender_encrypted),
       birth_date_encrypted      = COALESCE(survivor.birth_date_encrypted,  absorbed.birth_date_encrypted),
       document_number_encrypted = COALESCE(survivor.document_number_encrypted, absorbed.document_number_encrypted),
       -- document_type DEVE acompanhar document_number_encrypted: a constraint
       -- check_document_type_required (mig 026) exige type quando há número. Sem
       -- esta linha, herdar o número do absorvido sem o type viola a constraint (23514).
       document_type             = COALESCE(survivor.document_type,         absorbed.document_type),
       languages_encrypted       = COALESCE(survivor.languages_encrypted,   absorbed.languages_encrypted),
       profession                = COALESCE(survivor.profession,            absorbed.profession),
       knowledge_level           = COALESCE(survivor.knowledge_level,       absorbed.knowledge_level),
       years_experience          = COALESCE(survivor.years_experience,      absorbed.years_experience),
       experience_types          = COALESCE(survivor.experience_types,      absorbed.experience_types),
       preferred_types           = COALESCE(survivor.preferred_types,       absorbed.preferred_types),
       preferred_age_range       = COALESCE(survivor.preferred_age_range,   absorbed.preferred_age_range),
       name_trgm_bidx            = COALESCE(survivor.name_trgm_bidx,        absorbed.name_trgm_bidx),
       sex_bidx                  = COALESCE(survivor.sex_bidx,              absorbed.sex_bidx),
       languages_bidx            = COALESCE(survivor.languages_bidx,        absorbed.languages_bidx),
       -- Consentimento viaja em trio (mesmo contrato de updateAuthUid): herdar só
       -- lgpd_consent_at deixaria terms/privacy órfãos no casco (caso Edith, 04/08).
       lgpd_consent_at           = COALESCE(survivor.lgpd_consent_at,       absorbed.lgpd_consent_at),
       terms_accepted_at         = COALESCE(survivor.terms_accepted_at,     absorbed.terms_accepted_at),
       privacy_accepted_at       = COALESCE(survivor.privacy_accepted_at,   absorbed.privacy_accepted_at),
       data_sources = ARRAY(
         SELECT DISTINCT unnest(
           array_cat(
             COALESCE(survivor.data_sources, '{}'),
             COALESCE(absorbed.data_sources, '{}')
           )
         )
       ),
       updated_at = NOW()
     FROM workers absorbed
     WHERE survivor.id = $1
       AND absorbed.id = $2`,
    [survivorId, absorbedId],
  );

  const result = await client.query<{ fields_filled: string[] }>(
    `SELECT ARRAY_REMOVE(ARRAY[
       CASE WHEN s.first_name_encrypted      IS NULL AND a.first_name_encrypted      IS NOT NULL THEN 'first_name_encrypted'      END,
       CASE WHEN s.last_name_encrypted       IS NULL AND a.last_name_encrypted       IS NOT NULL THEN 'last_name_encrypted'       END,
       CASE WHEN s.document_number_encrypted IS NULL AND a.document_number_encrypted IS NOT NULL THEN 'document_number_encrypted' END,
       CASE WHEN s.profession                IS NULL AND a.profession                IS NOT NULL THEN 'profession'                END,
       CASE WHEN s.knowledge_level           IS NULL AND a.knowledge_level           IS NOT NULL THEN 'knowledge_level'           END,
       CASE WHEN s.languages_encrypted       IS NULL AND a.languages_encrypted       IS NOT NULL THEN 'languages_encrypted'       END
     ], NULL) AS fields_filled
     FROM workers s, workers a
     WHERE s.id = $1 AND a.id = $2`,
    [survivorId, absorbedId],
  );

  return { fieldsFilled: result.rows[0]?.fields_filled ?? [] };
}

// ─── MOVE de campos de identidade únicos ──────────────────────────────────

interface IdentityFieldsRow {
  id: string;
  phone: string | null;
  phone_encrypted: string | null;
  whatsapp_phone_encrypted: string | null;
  ana_care_id: string | null;
}

/**
 * MOVE (não copia) phone + ciphertext, whatsapp e ana_care_id do absorvido
 * para o sobrevivente quando o sobrevivente não os tem.
 *
 * idx_workers_phone_unique e idx_workers_ana_care_id_unique NÃO filtram
 * merged_into_id — o casco mergeado continua ocupando o slot. A ordem é
 * obrigatória: limpar o absorvido ANTES de gravar no sobrevivente, na MESMA
 * transação (a constraint é checada por statement). Provado no caso Edith.
 */
export async function moveUniqueIdentityFields(
  client: PoolClient,
  survivorId: string,
  absorbedId: string,
): Promise<{ fieldsMoved: string[] }> {
  const res = await client.query<IdentityFieldsRow>(
    `SELECT id, phone, phone_encrypted, whatsapp_phone_encrypted, ana_care_id
     FROM workers
     WHERE id = ANY(ARRAY[$1, $2]::uuid[])
     FOR UPDATE`,
    [survivorId, absorbedId],
  );
  const survivor = res.rows.find(r => r.id === survivorId);
  const absorbed = res.rows.find(r => r.id === absorbedId);
  if (!survivor || !absorbed) return { fieldsMoved: [] };

  // phone e phone_encrypted viajam como unidade (gate no phone público)
  const moves: Array<{ col: keyof IdentityFieldsRow }> = [];
  if (absorbed.phone != null && survivor.phone == null) {
    moves.push({ col: 'phone' }, { col: 'phone_encrypted' });
  }
  if (absorbed.whatsapp_phone_encrypted != null && survivor.whatsapp_phone_encrypted == null) {
    moves.push({ col: 'whatsapp_phone_encrypted' });
  }
  if (absorbed.ana_care_id != null && survivor.ana_care_id == null) {
    moves.push({ col: 'ana_care_id' });
  }
  if (moves.length === 0) return { fieldsMoved: [] };

  const cols = moves.map(m => m.col);

  // 1) Limpa o casco — libera os índices únicos
  await client.query(
    `UPDATE workers
     SET ${cols.map(c => `${c} = NULL`).join(', ')}, updated_at = NOW()
     WHERE id = $1::uuid`,
    [absorbedId],
  );

  // 2) Grava no sobrevivente
  await client.query(
    `UPDATE workers
     SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW()
     WHERE id = $${cols.length + 1}::uuid`,
    [...cols.map(c => absorbed[c]), survivorId],
  );

  return { fieldsMoved: cols };
}
