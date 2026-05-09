import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { GCSStorageService } from '../../infrastructure/GCSStorageService';
import { generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import { mapPlatformLabel, matchesSearch, WorkerListItem } from './AdminWorkersControllerHelpers';
import { buildWorkerDetailResponse } from './AdminWorkersDetailBuilder';
import { ExportWorkersUseCase } from '../../application/ExportWorkersUseCase';
import { WORKER_EXPORT_COLUMN_KEYS, WorkerExportColumnKey } from '../../application/export/workerExportColumns';
import { buildAllValidatedClause, buildPendingValidationClause } from '../../application/workerDocumentFilters';

// Campos selecionados para detalhe de worker — compartilhado por getWorkerById e getWorkerByPhone
const WORKER_DETAIL_COLS = [
  'w.id, w.email, w.phone, w.country, w.timezone, w.status',
  'w.data_sources, w.created_at, w.updated_at, w.deleted_at',
  'w.document_type, w.profession, w.occupation, w.knowledge_level',
  'w.title_certificate, w.experience_types, w.years_experience',
  'w.preferred_types, w.preferred_age_range, w.hobbies, w.diagnostic_preferences',
  'w.first_name_encrypted, w.last_name_encrypted, w.birth_date_encrypted',
  'w.sex_encrypted, w.gender_encrypted, w.document_number_encrypted',
  'w.profile_photo_url_encrypted, w.languages_encrypted',
  'w.whatsapp_phone_encrypted, w.linkedin_url_encrypted',
  'w.sexual_orientation_encrypted, w.race_encrypted, w.religion_encrypted',
  'w.weight_kg_encrypted, w.height_cm_encrypted',
].join(', ');

// ── Shared docs_validated enum ────────────────────────────────────────────────

const DocsValidatedEnum = z.enum(['all_validated', 'pending_validation']);
type DocsValidated = z.infer<typeof DocsValidatedEnum>;

// ── List query params schema ──────────────────────────────────────────────────

const ListWorkersQuerySchema = z.object({
  platform: z.string().optional(),
  docs_complete: z.string().optional(),
  docs_validated: DocsValidatedEnum.optional(),
  search: z.string().optional(),
  case_id: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

// ── Export query params schema ────────────────────────────────────────────────

const ExportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']),
  columns: z.string().min(1),
  status: z.string().optional(),
  platform: z.string().optional(),
  docs_complete: z.string().optional(),
  docs_validated: DocsValidatedEnum.optional(),
  case_id: z.string().optional(),
});

/**
 * AdminWorkersController
 *
 * Core list/detail/export endpoints. Auxiliary endpoints (stats, case-options,
 * sync-talentum) live in AdminWorkersAuxController.
 *
 * Endpoints:
 * - GET /api/admin/workers                 - Lista workers com filtros e paginação
 * - GET /api/admin/workers/by-phone        - Detalhes completos de um worker por telefone
 * - GET /api/admin/workers/export          - Exporta workers para CSV ou XLSX
 * - GET /api/admin/workers/:id             - Detalhes completos de um worker por ID
 */
export class AdminWorkersController {
  private db: Pool;
  private encryptionService: KMSEncryptionService;
  private blindIndexService: BlindIndexService;
  private readonly gcs = new GCSStorageService();

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.blindIndexService = new BlindIndexService();
  }

  private async decryptWorkerListRow(row: any): Promise<{ firstName: string; lastName: string; phone: string; worker: WorkerListItem }> {
    const [firstName, lastName] = await Promise.all([
      this.encryptionService.decrypt(row.first_name_encrypted),
      this.encryptionService.decrypt(row.last_name_encrypted),
    ]);
    return {
      firstName: firstName ?? '',
      lastName: lastName ?? '',
      phone: row.phone ?? '',
      worker: {
        id: row.id,
        name: [firstName, lastName].filter(Boolean).join(' ') || row.email,
        email: row.email,
        casesCount: parseInt(row.cases_count ?? '0', 10),
        documentsStatus: row.documents_status,
        documentsComplete: row.status === 'REGISTERED',
        status: row.status,
        platform: mapPlatformLabel(row.data_sources ?? []),
        createdAt: row.created_at,
      },
    };
  }

  /** Appends the docs_validated WHERE fragment for 'all_validated' | 'pending_validation'. */
  private applyDocsValidatedFilter(whereClause: string, docsValidated: DocsValidated | undefined): string {
    if (docsValidated === 'all_validated') {
      return whereClause + ` AND ${buildAllValidatedClause('wd')}`;
    }
    if (docsValidated === 'pending_validation') {
      return whereClause + ` AND ${buildPendingValidationClause('wd')}`;
    }
    return whereClause;
  }

  /** GET /api/admin/workers — lista com filtros e paginação */
  async listWorkers(req: Request, res: Response): Promise<void> {
    const parsed = ListWorkersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid query params', details: parsed.error.flatten() });
      return;
    }

    try {
      const { platform, docs_complete, docs_validated, search, case_id, limit = '20', offset = '0' } = parsed.data;
      const params: unknown[] = [];
      let paramIndex = 1;
      let whereClause = 'WHERE w.merged_into_id IS NULL';

      if (platform) {
        if (platform === 'talentum') {
          whereClause += ` AND (w.data_sources && ARRAY['candidatos', 'candidatos_no_terminaron']::text[])`;
        } else if (platform === 'enlite_app') {
          whereClause += ` AND (w.data_sources IS NULL OR w.data_sources = '{}')`;
        } else {
          whereClause += ` AND ($${paramIndex} = ANY(w.data_sources))`;
          params.push(platform);
          paramIndex++;
        }
      }

      if (docs_complete === 'complete') {
        whereClause += ` AND w.status = 'REGISTERED'`;
      } else if (docs_complete === 'incomplete') {
        whereClause += ` AND w.status = 'INCOMPLETE_REGISTER'`;
      }

      whereClause = this.applyDocsValidatedFilter(whereClause, docs_validated);

      if (case_id) {
        whereClause += ` AND EXISTS (SELECT 1 FROM encuadres e2 WHERE e2.worker_id = w.id AND e2.job_posting_id = $${paramIndex})`;
        params.push(case_id);
        paramIndex++;
      }

      const searchRaw = search?.trim();
      const searchTerm = searchRaw?.toLowerCase();
      const isEmailSearch = !!searchRaw && searchRaw.includes('@');
      const phoneDigits = searchRaw?.replace(/[\s+\-()]/g, '') ?? '';
      const isPhoneSearch = !isEmailSearch && /^\d{4,}$/.test(phoneDigits);
      const isNameSearch = !!searchTerm && !isEmailSearch && !isPhoneSearch;

      if (searchTerm && (isEmailSearch || isPhoneSearch)) {
        const likeField = isEmailSearch ? 'w.email' : 'w.phone';
        const likeValue = `%${isEmailSearch ? searchTerm : phoneDigits}%`;
        whereClause += ` AND ${likeField} ILIKE $${paramIndex}`;
        params.push(likeValue);
        paramIndex++;
      }

      if (isNameSearch) {
        let searchBidxLiteral: string | null;
        try {
          const buffers = await this.blindIndexService.generateSearchTrigramBidx(searchRaw!);
          searchBidxLiteral = this.blindIndexService.serializeForPg(buffers);
        } catch (err: any) {
          res.status(400).json({ success: false, error: err.message ?? 'Invalid search term' });
          return;
        }

        if (searchBidxLiteral === null) {
          res.status(400).json({ success: false, error: 'Search term must have at least 3 characters' });
          return;
        }

        whereClause += ` AND w.name_trgm_bidx @> $${paramIndex}::bytea[]`;
        params.push(searchBidxLiteral);
        paramIndex++;
      }

      const baseQuery = `
        SELECT w.id, w.email, w.phone, w.first_name_encrypted, w.last_name_encrypted,
          w.data_sources, w.created_at, w.status,
          COALESCE(wd.documents_status, 'pending') AS documents_status,
          COUNT(DISTINCT e.job_posting_id) FILTER (WHERE e.resultado = 'SELECCIONADO') AS cases_count
        FROM workers w
        LEFT JOIN worker_documents wd ON wd.worker_id = w.id
        LEFT JOIN encuadres e ON e.worker_id = w.id
        ${whereClause}
        GROUP BY w.id, wd.documents_status
      `;

      if (isNameSearch) {
        const CANDIDATE_LIMIT = 200;
        const fetchParams = [...params, CANDIDATE_LIMIT];
        const result = await this.db.query(
          `${baseQuery} ORDER BY w.created_at DESC LIMIT $${paramIndex}`,
          fetchParams,
        );

        const decryptedAll = await Promise.all(result.rows.map((row) => this.decryptWorkerListRow(row)));
        const filtered = decryptedAll.filter(
          ({ firstName, lastName, worker, phone }) => matchesSearch(searchTerm!, [firstName, lastName, worker.email, phone]),
        );

        const paginatedOffset = parseInt(offset, 10);
        const paginatedLimit = parseInt(limit, 10);
        const data = filtered.slice(paginatedOffset, paginatedOffset + paginatedLimit).map(({ worker }) => worker);
        res.status(200).json({ success: true, data, total: filtered.length, limit: paginatedLimit, offset: paginatedOffset });
      } else {
        const countResult = await this.db.query(`SELECT COUNT(*) AS total FROM (${baseQuery}) AS sub`, params);
        const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

        const dataQuery = `${baseQuery} ORDER BY w.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));
        const result = await this.db.query(dataQuery, params);

        const data = (await Promise.all(result.rows.map((row) => this.decryptWorkerListRow(row)))).map(({ worker }) => worker);
        res.status(200).json({ success: true, data, total, limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
      }
    } catch (error: any) {
      console.error('[AdminWorkersController] listWorkers error:', error);
      res.status(500).json({ success: false, error: 'Failed to list workers', details: error.message });
    }
  }

  /**
   * GET /api/admin/workers/:id
   * Retorna detalhes completos de um worker por ID.
   */
  async getWorkerById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const workerResult = await this.db.query(
        `SELECT ${WORKER_DETAIL_COLS} FROM workers w WHERE w.id = $1 AND w.merged_into_id IS NULL`,
        [id],
      );
      if (workerResult.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }
      const data = await buildWorkerDetailResponse(this.db, this.encryptionService, this.gcs, workerResult.rows[0]);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AdminWorkersController] getWorkerById error:', error);
      res.status(500).json({ success: false, error: 'Failed to get worker details', details: error.message });
    }
  }

  /**
   * GET /api/admin/workers/by-phone?phone=...
   * Busca worker pelo número de telefone. Retorna os mesmos dados completos de getWorkerById.
   */
  async getWorkerByPhone(req: Request, res: Response): Promise<void> {
    try {
      const { phone } = req.query as Record<string, string>;
      if (!phone || phone.trim() === '') {
        res.status(400).json({ success: false, error: 'Query parameter "phone" is required' });
        return;
      }
      const candidates = generatePhoneCandidates(phone);
      if (candidates.length === 0) {
        res.status(400).json({ success: false, error: 'Query parameter "phone" is required' });
        return;
      }
      const workerResult = await this.db.query(
        `SELECT ${WORKER_DETAIL_COLS} FROM workers w WHERE w.phone = ANY($1::text[]) AND w.merged_into_id IS NULL`,
        [candidates],
      );
      if (workerResult.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }
      const data = await buildWorkerDetailResponse(this.db, this.encryptionService, this.gcs, workerResult.rows[0]);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AdminWorkersController] getWorkerByPhone error:', error);
      res.status(500).json({ success: false, error: 'Failed to get worker details', details: error.message });
    }
  }

  /**
   * GET /api/admin/workers/export
   * Exports workers to CSV (streamed) or XLSX (buffered).
   * Admin only. Supports status, platform, docs_complete and case_id filters.
   */
  async exportWorkers(req: Request, res: Response): Promise<void> {
    // 5-minute timeout for large exports
    req.setTimeout(5 * 60_000);
    res.setTimeout(5 * 60_000);

    const parsed = ExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid query params', details: parsed.error.flatten() });
      return;
    }

    const { format, columns: columnsParam, status, platform, docs_complete, docs_validated, case_id } = parsed.data;

    // Validate individual column keys
    const columnKeys = columnsParam.split(',').map((c) => c.trim()).filter(Boolean);
    if (columnKeys.length === 0) {
      res.status(400).json({ success: false, error: 'At least one column is required' });
      return;
    }
    const invalid = columnKeys.filter((k) => !WORKER_EXPORT_COLUMN_KEYS.has(k as WorkerExportColumnKey));
    if (invalid.length > 0) {
      res.status(400).json({ success: false, error: `Unknown columns: ${invalid.join(', ')}` });
      return;
    }

    const columns = columnKeys as WorkerExportColumnKey[];
    const statusLabel = status ?? 'ALL';
    const date = new Date().toISOString().slice(0, 10);

    try {
      const useCase = new ExportWorkersUseCase();
      const result = await useCase.execute({
        format,
        columns,
        filters: { status, platform, docs_complete, docs_validated, case_id },
      });

      if (result.format === 'xlsx') {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="workers_${statusLabel}_${date}.xlsx"`);
        res.send(result.xlsxBuffer);
        return;
      }

      // CSV — stream line by line
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="workers_${statusLabel}_${date}.csv"`);

      for await (const line of result.csvLines!) {
        res.write(line);
      }
      res.end();
    } catch (error: any) {
      console.error('[AdminWorkersController] exportWorkers error:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Export failed', details: error.message });
      } else {
        res.end();
      }
    }
  }
}
