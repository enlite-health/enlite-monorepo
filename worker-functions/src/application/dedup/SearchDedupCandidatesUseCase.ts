/**
 * SearchDedupCandidatesUseCase
 *
 * Busca candidatos para merge manual no Centro de Duplicados.
 *
 * Estratégia de busca:
 *   - Se q tem < 2 chars → retorna []
 *   - Busca por NOME via blind index trigram (name_trgm_bidx @> $bidx)
 *   - Se q contém dígitos → busca adicional por phone_normalized (ILIKE '%digits%')
 *   - Combina os dois resultados (UNION/dedup por id)
 *   - Exclui workers com merged_into_id IS NOT NULL
 *   - Decripta nome via loadWorkerDisplayNames
 *
 * Resposta: CandidateItem[]
 *   { id, name, phone, email, login_real, is_imported }
 */

import type { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { loadWorkerDisplayNames } from './loadWorkerDisplayNames';
import { IMPORT_EMAIL_SUFFIX, SYNTHETIC_AUTH_UID_PREFIXES } from '../../infrastructure/services/WorkerPhoneMergeTypes';

const log = logger.child({ source: 'SearchDedupCandidatesUseCase' });

// ── Tipos ──────────────────────────────────────────────────────────────────

export interface CandidateItem {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  login_real: boolean;
  is_imported: boolean;
}

export interface SearchDedupCandidatesParams {
  q: string;
  limit?: number;
}

// ── Raw DB row ─────────────────────────────────────────────────────────────

interface CandidateRow {
  id: string;
  email: string;
  phone_normalized: string | null;
  auth_uid: string | null;
}

// ── Use case ───────────────────────────────────────────────────────────────

export class SearchDedupCandidatesUseCase {
  private readonly blindIndex: BlindIndexService;
  private readonly encryptionService: KMSEncryptionService;

  constructor(
    private readonly pool: Pool,
    blindIndex?: BlindIndexService,
    encryptionService?: KMSEncryptionService,
  ) {
    this.blindIndex = blindIndex ?? new BlindIndexService();
    this.encryptionService = encryptionService ?? new KMSEncryptionService();
  }

  async execute(params: SearchDedupCandidatesParams): Promise<CandidateItem[]> {
    const { q, limit = 8 } = params;
    const safeLimit = Math.min(limit, 20);

    if (q.length < 2) {
      log.info({ msg: 'search_dedup_candidates_too_short', q });
      return [];
    }

    log.info({ msg: 'search_dedup_candidates_start', q, limit: safeLimit });

    const ids = await this.fetchCandidateIds(q, safeLimit);

    if (ids.length === 0) return [];

    const nameMap = await loadWorkerDisplayNames(this.pool, ids, this.encryptionService);
    const rows = await this.fetchCandidateRows(ids);

    const results: CandidateItem[] = rows.map(row => ({
      id: row.id,
      name: nameMap.get(row.id) ?? '(sin nombre)',
      phone: row.phone_normalized ?? null,
      email: row.email ?? null,
      login_real: isLoginReal(row.auth_uid, row.email),
      is_imported: isImportedEmail(row.email),
    }));

    log.info({ msg: 'search_dedup_candidates_done', found: results.length });
    return results;
  }

  // ── Fetch ids via name bidx OR phone ──────────────────────────────────

  private async fetchCandidateIds(q: string, limit: number): Promise<string[]> {
    const idSet = new Set<string>();

    // 1. Busca por nome (trigram blind index)
    const nameIds = await this.fetchByName(q, limit);
    for (const id of nameIds) idSet.add(id);

    // 2. Se q tem dígitos → busca por telefone
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 2) {
      const phoneIds = await this.fetchByPhone(digits, limit);
      for (const id of phoneIds) idSet.add(id);
    }

    // Limita o total (dedup entre os dois resultados)
    return [...idSet].slice(0, limit);
  }

  private async fetchByName(q: string, limit: number): Promise<string[]> {
    let bidxBuffers: Buffer[];
    try {
      bidxBuffers = await this.blindIndex.generateSearchTrigramBidx(q);
    } catch {
      // q muito curto para gerar trigramas — silencioso (< 3 chars)
      return [];
    }

    const bidxLiteral = this.blindIndex.serializeForPg(bidxBuffers);
    if (!bidxLiteral) return [];

    try {
      const res = await this.pool.query<{ id: string }>(
        `SELECT w.id
           FROM workers w
          WHERE w.merged_into_id IS NULL
            AND w.name_trgm_bidx @> $1::bytea[]
          ORDER BY w.created_at DESC
          LIMIT $2`,
        [bidxLiteral, limit],
      );
      return res.rows.map(r => r.id);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'SearchDedupCandidatesUseCase:fetchByName' });
      return [];
    }
  }

  private async fetchByPhone(digits: string, limit: number): Promise<string[]> {
    try {
      const res = await this.pool.query<{ id: string }>(
        `SELECT w.id
           FROM workers w
          WHERE w.merged_into_id IS NULL
            AND w.phone_normalized ILIKE $1
          ORDER BY w.created_at DESC
          LIMIT $2`,
        [`%${digits}%`, limit],
      );
      return res.rows.map(r => r.id);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'SearchDedupCandidatesUseCase:fetchByPhone' });
      return [];
    }
  }

  // ── Fetch full rows for the collected ids ─────────────────────────────

  private async fetchCandidateRows(ids: string[]): Promise<CandidateRow[]> {
    const res = await this.pool.query<CandidateRow>(
      `SELECT w.id, w.email, w.phone_normalized, w.auth_uid
         FROM workers w
        WHERE w.id = ANY($1::uuid[])`,
      [ids],
    );
    return res.rows;
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

function isImportedEmail(email: string | null): boolean {
  if (!email) return false;
  return email.toLowerCase().includes(IMPORT_EMAIL_SUFFIX);
}

function isSyntheticUid(authUid: string | null | undefined): boolean {
  if (!authUid || authUid.trim() === '') return true;
  return SYNTHETIC_AUTH_UID_PREFIXES.some(prefix => authUid.startsWith(prefix));
}

function isLoginReal(authUid: string | null, email: string | null): boolean {
  return !isSyntheticUid(authUid) && !isImportedEmail(email);
}
