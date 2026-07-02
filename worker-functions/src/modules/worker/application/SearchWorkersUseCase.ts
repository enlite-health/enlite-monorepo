import type { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import {
  buildWorkerListWhereClause,
  appendSexFilter,
  appendLanguageFilter,
} from '../interfaces/controllers/AdminWorkersListHelpers';
import { matchesSearch } from '../interfaces/controllers/AdminWorkersControllerHelpers';

export interface SearchWorkersParams {
  /** Email (com @), telefone (dígitos) ou nome (trigram blind index). */
  search?: string;
  status?: string;
  /** CSV — mesma allowlist do painel admin (AT, CAREGIVER, NURSE, ...). */
  profession?: string;
  sex?: string;
  language?: string;
  limit: number;
  offset: number;
}

export interface SearchWorkersItem {
  id: string;
  name: string;
  email: string;
  status: string;
  documentsStatus: string;
  createdAt: string;
}

export interface SearchWorkersResult {
  workers: SearchWorkersItem[];
  total: number;
  limit: number;
  offset: number;
}

/** Candidatos buscados quando o search é por nome (filtro pós-decrypt em memória). */
const NAME_SEARCH_CANDIDATE_LIMIT = 200;

/**
 * Busca paginada de workers pro MCP (worker.search). Mesma mecânica do
 * GET /api/admin/workers (AdminWorkersController.listWorkers): filtros via
 * AdminWorkersListHelpers, nome via trigram blind index + match pós-decrypt.
 * Retorna só campos de lista (nome decriptado, email, status) — detalhe
 * completo continua via worker.profile.get.
 */
export class SearchWorkersUseCase {
  constructor(
    private readonly db: Pool,
    private readonly encryption: KMSEncryptionService = new KMSEncryptionService(),
    private readonly blindIndex: BlindIndexService = new BlindIndexService(),
  ) {}

  async execute(params: SearchWorkersParams): Promise<SearchWorkersResult> {
    const { limit, offset } = params;

    let { whereClause, params: sqlParams, paramIndex } = buildWorkerListWhereClause({
      ...(params.profession !== undefined ? { profession: params.profession } : {}),
      limit: String(limit),
      offset: String(offset),
    });

    if (params.status) {
      whereClause += ` AND w.status = $${paramIndex}`;
      sqlParams.push(params.status);
      paramIndex++;
    }

    ({ whereClause, params: sqlParams, paramIndex } = await appendSexFilter(
      this.blindIndex, whereClause, sqlParams, paramIndex, params.sex,
    ));
    ({ whereClause, params: sqlParams, paramIndex } = await appendLanguageFilter(
      this.blindIndex, whereClause, sqlParams, paramIndex, params.language,
    ));

    // Mesma tripla estratégia do painel: email → ILIKE, telefone → ILIKE, nome → bidx
    const searchRaw = params.search?.trim();
    const searchTerm = searchRaw?.toLowerCase();
    const isEmailSearch = !!searchRaw && searchRaw.includes('@');
    const phoneDigits = searchRaw?.replace(/[\s+\-()]/g, '') ?? '';
    const isPhoneSearch = !isEmailSearch && /^\d{4,}$/.test(phoneDigits);
    const isNameSearch = !!searchTerm && !isEmailSearch && !isPhoneSearch;

    if (searchTerm && (isEmailSearch || isPhoneSearch)) {
      const likeField = isEmailSearch ? 'w.email' : 'w.phone';
      whereClause += ` AND ${likeField} ILIKE $${paramIndex}`;
      sqlParams.push(`%${isEmailSearch ? searchTerm : phoneDigits}%`);
      paramIndex++;
    }

    if (isNameSearch) {
      const buffers = await this.blindIndex.generateSearchTrigramBidx(searchRaw as string);
      const literal = this.blindIndex.serializeForPg(buffers);
      if (literal === null) {
        throw new Error('Search term must have at least 3 characters');
      }
      whereClause += ` AND w.name_trgm_bidx @> $${paramIndex}::bytea[]`;
      sqlParams.push(literal);
      paramIndex++;
    }

    const baseQuery = `
      SELECT w.id, w.email, w.phone, w.first_name_encrypted, w.last_name_encrypted,
        w.created_at, w.status,
        COALESCE(wd.documents_status, 'pending') AS documents_status
      FROM workers w
      LEFT JOIN worker_documents wd ON wd.worker_id = w.id
      ${whereClause}
    `;

    if (isNameSearch) {
      const result = await this.db.query(
        `${baseQuery} ORDER BY w.created_at DESC LIMIT $${paramIndex}`,
        [...sqlParams, NAME_SEARCH_CANDIDATE_LIMIT],
      );
      const decrypted = await Promise.all(result.rows.map((row) => this.decryptRow(row)));
      const filtered = decrypted.filter(({ names, item, phone }) =>
        matchesSearch(searchTerm as string, [...names, item.email, phone]),
      );
      return {
        workers: filtered.slice(offset, offset + limit).map(({ item }) => item),
        total: filtered.length,
        limit,
        offset,
      };
    }

    const countResult = await this.db.query(
      `SELECT COUNT(*) AS total FROM (${baseQuery}) AS sub`,
      sqlParams,
    );
    const total = parseInt((countResult.rows[0] as { total: string })?.total ?? '0', 10);

    const result = await this.db.query(
      `${baseQuery} ORDER BY w.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...sqlParams, limit, offset],
    );
    const decrypted = await Promise.all(result.rows.map((row) => this.decryptRow(row)));
    return { workers: decrypted.map(({ item }) => item), total, limit, offset };
  }

  private async decryptRow(
    row: Record<string, unknown>,
  ): Promise<{ item: SearchWorkersItem; names: string[]; phone: string }> {
    const [firstName, lastName] = await Promise.all([
      this.encryption.decrypt(row.first_name_encrypted as string | null),
      this.encryption.decrypt(row.last_name_encrypted as string | null),
    ]);
    return {
      names: [firstName ?? '', lastName ?? ''],
      phone: (row.phone as string) ?? '',
      item: {
        id: row.id as string,
        name: [firstName, lastName].filter(Boolean).join(' ') || (row.email as string),
        email: row.email as string,
        status: row.status as string,
        documentsStatus: row.documents_status as string,
        createdAt: row.created_at as string,
      },
    };
  }
}
