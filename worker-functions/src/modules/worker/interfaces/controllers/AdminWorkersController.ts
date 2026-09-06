import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { GCSStorageService } from '../../infrastructure/GCSStorageService';
import { generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import { mapPlatformLabel, matchesSearch, WorkerListItem, WORKER_DETAIL_COLS } from './AdminWorkersControllerHelpers';
import { buildWorkerDetailResponse } from './AdminWorkersDetailBuilder';
import { ExportWorkersUseCase, ExportSemColunaPermitidaError } from '../../application/ExportWorkersUseCase';
import { cellsOfRequest } from '@modules/identity/permissions';
import { servedWorkerContainers } from '../../application/workerContainerAccess';
import { WORKER_EXPORT_COLUMN_KEYS, WorkerExportColumnKey } from '../../application/export/workerExportColumns';
import { buildAllValidatedClause, buildPendingValidationClause } from '../../application/workerDocumentFilters';
import {
  buildWorkerListWhereClause,
  appendSexFilter,
  appendLanguageFilter,
} from './AdminWorkersListHelpers';
import { logger, reportError } from '@shared/logging';

// ── Shared docs_validated enum ────────────────────────────────────────────────

const DocsValidatedEnum = z.enum(['all_validated', 'pending_validation']);
type DocsValidated = z.infer<typeof DocsValidatedEnum>;

// ── List query params schema ──────────────────────────────────────────────────

const ListWorkersQuerySchema = z.object({
  /**
   * Status exato do worker. Ausente = a lista exclui os DISABLED (baixa de
   * conta) — ver activeWorkerFilter. Passar `DISABLED` é como o admin acha
   * quem deu baixa para eventualmente reverter.
   *
   * Faltava no schema: `?status=` era aceito pela rota e descartado em silêncio
   * pelo strip do zod, então o filtro nunca teve efeito (achado por e2e, 05/08).
   */
  status: z.enum(['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED']).optional(),
  platform: z.string().optional(),
  docs_complete: z.string().optional(),
  docs_validated: DocsValidatedEnum.optional(),
  search: z.string().optional(),
  case_id: z.string().optional(),
  /** CSV de UUIDs de tags. Filtra workers que possuem TODAS as tags informadas (AND). */
  tag_ids: z.string().optional(),
  /** CSV de profissões aceitas: AT,CAREGIVER,NURSE,KINESIOLOGIST,PSYCHOLOGIST */
  profession: z.string().optional(),
  /** Faixa etária preferida (single value) — ex.: 'children', 'elderly' */
  preferred_age_range: z.string().optional(),
  /** Tipo de experiência (single value) — ex.: 'TEA', 'DOWN' */
  experience_type: z.string().optional(),
  /** Tipo de atendimento preferido (single value) — ex.: 'home', 'institutional' */
  preferred_type: z.string().optional(),
  /** Idioma (single code) — filtro via blind index languages_bidx — ex.: 'es', 'pt' */
  language: z.string().optional(),
  /** Sexo do worker — 'male' | 'female' — filtro via blind index sex_bidx */
  sex: z.string().optional(),
  /** Província/estado — ILIKE em worker_service_areas.state */
  state: z.string().optional(),
  /** Cidade — ILIKE em worker_service_areas.city */
  city: z.string().optional(),
  /** CSV de dias da semana (0-6) — ex.: '1,2,3' */
  days: z.string().optional(),
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

  private async decryptWorkerListRow(row: Record<string, unknown>): Promise<{ firstName: string; lastName: string; phone: string; worker: WorkerListItem }> {
    const [firstName, lastName] = await Promise.all([
      this.encryptionService.decrypt(row.first_name_encrypted as string | null),
      this.encryptionService.decrypt(row.last_name_encrypted as string | null),
    ]);
    return {
      firstName: firstName ?? '',
      lastName: lastName ?? '',
      phone: (row.phone as string) ?? '',
      worker: {
        id: row.id as string,
        name: [firstName, lastName].filter(Boolean).join(' ') || (row.email as string),
        email: row.email as string,
        casesCount: parseInt((row.cases_count as string) ?? '0', 10),
        documentsStatus: row.documents_status as string,
        documentsComplete: row.status === 'REGISTERED',
        status: row.status as string,
        platform: mapPlatformLabel((row.data_sources as string[]) ?? []),
        createdAt: row.created_at as string,
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
      const {
        docs_validated, search,
        tag_ids, sex, language,
        limit = '20', offset = '0',
        ...filterRest
      } = parsed.data;

      // Validate tag UUIDs before building query
      if (tag_ids) {
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const tagArray = tag_ids.split(',').map((t) => t.trim()).filter(Boolean);
        const invalidUuids = tagArray.filter((t) => !UUID_RE.test(t));
        if (invalidUuids.length > 0) {
          res.status(400).json({ success: false, error: `Invalid tag UUIDs: ${invalidUuids.join(', ')}` });
          return;
        }
      }

      // Build synchronous WHERE clause
      let { whereClause, params, paramIndex } = buildWorkerListWhereClause({
        ...filterRest,
        tag_ids,
        limit,
        offset,
      });

      // Apply docs_validated (synchronous)
      whereClause = this.applyDocsValidatedFilter(whereClause, docs_validated);

      // Apply blind-index filters (async)
      ({ whereClause, params, paramIndex } = await appendSexFilter(
        this.blindIndexService, whereClause, params, paramIndex, sex,
      ));
      ({ whereClause, params, paramIndex } = await appendLanguageFilter(
        this.blindIndexService, whereClause, params, paramIndex, language,
      ));

      // Search filter
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
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Invalid search term';
          res.status(400).json({ success: false, error: msg });
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
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'AdminWorkersController:listWorkers' });
      res.status(500).json({ success: false, error: 'Failed to list workers', details: e.message });
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
      // C6: a trilha precisa do UUID, e o telefone NÃO pode ser o identificador
      // dela. O handler é o primeiro ponto onde o worker existe; `logResourceAccess`
      // lê isto no `finish`.
      req.recursoAcessadoId = workerResult.rows[0].id as string;

      // D286 fase 2: a ficha sai PROJETADA pelas células do ator (contato, dossiê, documentos,
      // encuadres); a rota só exige o operacional. `null` = engine não decidiu → ficha inteira (D113).
      const cells = cellsOfRequest(req);
      const data = await buildWorkerDetailResponse(this.db, this.encryptionService, this.gcs, workerResult.rows[0], cells);
      // Trilha de leitura sem valor: uid, prestador, país, containers servidos, quando. Nunca o
      // nome, o telefone ou a URL de documento. (A linha em `resource_access_log` vem do
      // `logResourceAccess('worker')` da rota.)
      logger.info({
        msg: 'worker_detail.read',
        uid: req.user?.uid ?? null,
        workerId: workerResult.rows[0].id,
        country: workerResult.rows[0].country ?? null,
        containers: servedWorkerContainers(cells),
      });
      res.status(200).json({ success: true, data });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'AdminWorkersController:getWorkerById' });
      res.status(500).json({ success: false, error: 'Failed to get worker details', details: e.message });
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
      // C6: a trilha precisa do UUID, e o telefone NÃO pode ser o identificador
      // dela. O handler é o primeiro ponto onde o worker existe; `logResourceAccess`
      // lê isto no `finish`.
      req.recursoAcessadoId = workerResult.rows[0].id as string;

      // A MESMA projeção da ficha. A rota continua exigindo `worker_pii:read` (é o dossiê da Luz,
      // principal de serviço → `cells = null` → ficha inteira, como o contrato do rollout pede).
      const data = await buildWorkerDetailResponse(this.db, this.encryptionService, this.gcs, workerResult.rows[0], cellsOfRequest(req));
      res.status(200).json({ success: true, data });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'AdminWorkersController:getWorkerByPhone' });
      res.status(500).json({ success: false, error: 'Failed to get worker details', details: e.message });
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
        // C5: `cellsOfRequest` devolve `null` quando o engine não decidiu — e
        // `null` NÃO é `[]`. Escrever `?? []` aqui derrubaria o dossiê de todo
        // export antes mesmo do flip.
        cells: cellsOfRequest(req),
      });

      // Coluna negada NUNCA some em silêncio: planilha faltando coluna parece
      // cadastro incompleto, e quem exportou vai caçar o defeito no lugar errado.
      // Vai em header porque o corpo é o arquivo — não há onde pôr um aviso.
      if (result.negadas.length > 0) {
        res.setHeader('X-Colunas-Negadas', result.negadas.join(','));
        res.setHeader('X-Colunas-Negadas-Motivo', 'worker_pii:read');
      }

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
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      // Toda coluna pedida caiu no gate: é 403, não 500 e não planilha vazia.
      // Arquivo vazio parece base vazia; 500 parece defeito nosso. O que houve
      // foi falta de célula, e a resposta tem de dizer isso.
      if (e instanceof ExportSemColunaPermitidaError && !res.headersSent) {
        logger.warn({
          msg: 'export negado por célula', source: 'AdminWorkersController',
          negadas: e.negadas.join(','),
        });
        res.status(403).json({
          success: false,
          error: 'Sem permissão para as colunas pedidas',
          details: { negadas: e.negadas, exige: 'worker_pii:read' },
        });
        return;
      }
      logger.error({ msg: 'exportWorkers error', source: 'AdminWorkersController', err: e.message });
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Export failed', details: e.message });
      } else {
        res.end();
      }
    }
  }
}
