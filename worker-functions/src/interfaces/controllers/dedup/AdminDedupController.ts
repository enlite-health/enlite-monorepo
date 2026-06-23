/**
 * AdminDedupController
 *
 * Controller fino para o Centro de Duplicados. Sem lógica de negócio.
 * Toda lógica vive nos use cases em src/application/dedup/.
 *
 * Endpoints:
 *   GET  /api/admin/dedup/groups
 *   GET  /api/admin/dedup/groups/:phoneNormalized
 *   POST /api/admin/dedup/merge
 *   POST /api/admin/dedup/dismiss
 *   POST /api/admin/dedup/merges/:auditId/undo
 *   GET  /api/admin/dedup/history
 *   GET  /api/admin/dedup/imported-groups
 *   GET  /api/admin/dedup/candidates
 *   POST /api/admin/dedup/manual-group
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger, reportError } from '@shared/logging';
import { ListDedupGroupsUseCase } from '../../../application/dedup/ListDedupGroupsUseCase';
import { GetDedupGroupDetailUseCase } from '../../../application/dedup/GetDedupGroupDetailUseCase';
import { ExecuteAdminMergeUseCase } from '../../../application/dedup/ExecuteAdminMergeUseCase';
import { DismissGroupUseCase } from '../../../application/dedup/DismissGroupUseCase';
import { UndoMergeUseCase } from '../../../application/dedup/UndoMergeUseCase';
import { ListMergeHistoryUseCase } from '../../../application/dedup/ListMergeHistoryUseCase';
import { ListImportedDedupGroupsUseCase } from '../../../application/dedup/ListImportedDedupGroupsUseCase';
import { SearchDedupCandidatesUseCase } from '../../../application/dedup/SearchDedupCandidatesUseCase';
import {
  BuildManualDedupGroupUseCase,
  ManualDedupValidationError,
} from '../../../application/dedup/BuildManualDedupGroupUseCase';

const log = logger.child({ source: 'AdminDedupController' });

// ── Zod schemas ────────────────────────────────────────────────────────────

const MergeBodySchema = z.object({
  survivorId: z.string().uuid('survivorId deve ser UUID'),
  absorbedIds: z.array(z.string().uuid()).min(1, 'absorbedIds deve ter ao menos 1 item'),
  fieldChoices: z.record(z.string()).optional(),
});

const DismissBodySchema = z.object({
  phoneNormalized: z.string().min(1, 'phoneNormalized obrigatório'),
  reason: z.string().optional(),
});

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const ImportedGroupsQuerySchema = z.object({
  onlyWithReal: z
    .string()
    .optional()
    .transform(v => v === 'true')
    .pipe(z.boolean()),
});

const CandidatesQuerySchema = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

const ManualGroupBodySchema = z.object({
  ids: z
    .array(z.string().uuid('cada id deve ser UUID'))
    .min(2, 'ids deve ter ao menos 2 elementos')
    .max(5, 'ids deve ter no máximo 5 elementos'),
});

// ── Controller ─────────────────────────────────────────────────────────────

export class AdminDedupController {
  private readonly pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  // GET /api/admin/dedup/groups
  async listGroups(req: Request, res: Response): Promise<void> {
    try {
      const useCase = new ListDedupGroupsUseCase(this.pool);
      const groups = await useCase.execute();
      res.json({ success: true, data: groups, total: groups.length });
    } catch (err) {
      this.handleError(err, res, 'listGroups');
    }
  }

  // GET /api/admin/dedup/groups/:phoneNormalized
  async getGroupDetail(req: Request, res: Response): Promise<void> {
    const { phoneNormalized } = req.params;

    if (!phoneNormalized) {
      res.status(400).json({ success: false, error: 'phoneNormalized é obrigatório' });
      return;
    }

    try {
      const useCase = new GetDedupGroupDetailUseCase(this.pool);
      const detail = await useCase.execute(phoneNormalized);

      if (!detail) {
        res.status(404).json({ success: false, error: 'Grupo não encontrado' });
        return;
      }

      res.json({ success: true, data: detail });
    } catch (err) {
      this.handleError(err, res, 'getGroupDetail');
    }
  }

  // POST /api/admin/dedup/merge
  async executeMerge(req: Request, res: Response): Promise<void> {
    const parsed = MergeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.flatten() });
      return;
    }

    const adminUid = (req as Request & { user?: { uid?: string } }).user?.uid;

    try {
      const useCase = new ExecuteAdminMergeUseCase(this.pool);
      const result = await useCase.execute({
        survivorId: parsed.data.survivorId,
        absorbedIds: parsed.data.absorbedIds,
        fieldChoices: parsed.data.fieldChoices,
        executedBy: adminUid,
      });

      log.info({ msg: 'admin_merge_via_endpoint', adminUid, result });
      res.json({ success: true, data: result });
    } catch (err) {
      this.handleError(err, res, 'executeMerge');
    }
  }

  // POST /api/admin/dedup/dismiss
  async dismissGroup(req: Request, res: Response): Promise<void> {
    const parsed = DismissBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.flatten() });
      return;
    }

    const adminUid = (req as Request & { user?: { uid?: string } }).user?.uid;

    try {
      const useCase = new DismissGroupUseCase(this.pool);
      const result = await useCase.execute({
        phoneNormalized: parsed.data.phoneNormalized,
        reason: parsed.data.reason,
        dismissedBy: adminUid,
      });

      res.json({ success: true, data: result });
    } catch (err) {
      this.handleError(err, res, 'dismissGroup');
    }
  }

  // POST /api/admin/dedup/merges/:auditId/undo
  async undoMerge(req: Request, res: Response): Promise<void> {
    const auditIdRaw = Number(req.params.auditId);

    if (!Number.isInteger(auditIdRaw) || auditIdRaw <= 0) {
      res.status(400).json({ success: false, error: 'auditId inválido' });
      return;
    }

    try {
      const useCase = new UndoMergeUseCase(this.pool);
      const result = await useCase.execute(auditIdRaw);
      res.json({ success: true, data: result });
    } catch (err) {
      this.handleError(err, res, 'undoMerge');
    }
  }

  // GET /api/admin/dedup/history
  async listHistory(req: Request, res: Response): Promise<void> {
    const parsed = HistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.flatten() });
      return;
    }

    try {
      const useCase = new ListMergeHistoryUseCase(this.pool);
      const entries = await useCase.execute({ limit: parsed.data.limit, offset: parsed.data.offset });
      res.json({ success: true, data: entries, total: entries.length });
    } catch (err) {
      this.handleError(err, res, 'listHistory');
    }
  }

  // GET /api/admin/dedup/imported-groups
  async listImportedGroups(req: Request, res: Response): Promise<void> {
    const parsed = ImportedGroupsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.flatten() });
      return;
    }

    try {
      const useCase = new ListImportedDedupGroupsUseCase(this.pool);
      const groups = await useCase.execute({ onlyWithReal: parsed.data.onlyWithReal });
      res.json({ success: true, data: groups, total: groups.length });
    } catch (err) {
      this.handleError(err, res, 'listImportedGroups');
    }
  }

  // GET /api/admin/dedup/candidates?q=<text>&limit=<n>
  async searchCandidates(req: Request, res: Response): Promise<void> {
    const parsed = CandidatesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.flatten() });
      return;
    }

    try {
      const useCase = new SearchDedupCandidatesUseCase(this.pool);
      const data = await useCase.execute({ q: parsed.data.q, limit: parsed.data.limit });
      res.json({ success: true, data });
    } catch (err) {
      this.handleError(err, res, 'searchCandidates');
    }
  }

  // POST /api/admin/dedup/manual-group
  async buildManualGroup(req: Request, res: Response): Promise<void> {
    const parsed = ManualGroupBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.flatten() });
      return;
    }

    try {
      const useCase = new BuildManualDedupGroupUseCase(this.pool);
      const result = await useCase.execute(parsed.data.ids);
      res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof ManualDedupValidationError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      this.handleError(err, res, 'buildManualGroup');
    }
  }

  // ── Error handler ──────────────────────────────────────────────────────────

  private handleError(err: unknown, res: Response, method: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminDedupController:${method}` });
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
}
