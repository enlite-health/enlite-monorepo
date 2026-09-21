/**
 * AdminTagCatalogController
 *
 * Gerencia o catálogo de tags de workers e a associação worker ↔ tag.
 *
 * Rotas (registradas em src/index.ts):
 *   GET    /api/admin/worker-tags              tag:read   → list
 *   POST   /api/admin/worker-tags              tag:create → create
 *   PATCH  /api/admin/worker-tags/:id          tag:update → update
 *   DELETE /api/admin/worker-tags/:id          tag:delete → delete (soft)
 *   POST   /api/admin/workers/:id/tags/:tagId  worker:update → assign (dado do prestador)
 *   DELETE /api/admin/workers/:id/tags/:tagId  worker:update → remove (dado do prestador)
 *
 * Spec 024 (D1/D401, 21/09/2026): o catálogo (as 4 primeiras rotas) migrou de `worker:*` para
 * `tag:*` — é DADO diferente do perfil do prestador. Atribuir/remover tag DE UM prestador
 * continua em `worker:update`.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { WorkerTagRepository } from '../../infrastructure/WorkerTagRepository';
import { ListTagCatalogUseCase } from '../../application/ListTagCatalogUseCase';
import { CreateTagUseCase } from '../../application/CreateTagUseCase';
import { UpdateTagUseCase } from '../../application/UpdateTagUseCase';
import { DeleteTagUseCase } from '../../application/DeleteTagUseCase';
import { AssignTagToWorkerUseCase } from '../../application/AssignTagToWorkerUseCase';
import { RemoveTagFromWorkerUseCase } from '../../application/RemoveTagFromWorkerUseCase';
import { logger, reportError } from '@shared/logging';

// ── Validation schemas ────────────────────────────────────────────────────────

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

const CreateTagSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(HEX_COLOR_REGEX, 'color must be a hex string like #RRGGBB'),
  description: z.string().optional(),
});

const UpdateTagSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().regex(HEX_COLOR_REGEX, 'color must be a hex string like #RRGGBB').optional(),
  description: z.string().optional(),
});

// ── Helper ────────────────────────────────────────────────────────────────────

function getUid(req: Request): string | null {
  return (req as Request & { user?: { uid: string } }).user?.uid ?? null;
}

// ── Controller ────────────────────────────────────────────────────────────────

export class AdminTagCatalogController {
  private readonly listUseCase: ListTagCatalogUseCase;
  private readonly createUseCase: CreateTagUseCase;
  private readonly updateUseCase: UpdateTagUseCase;
  private readonly deleteUseCase: DeleteTagUseCase;
  private readonly assignUseCase: AssignTagToWorkerUseCase;
  private readonly removeUseCase: RemoveTagFromWorkerUseCase;

  constructor() {
    const repo = new WorkerTagRepository();
    this.listUseCase = new ListTagCatalogUseCase(repo);
    this.createUseCase = new CreateTagUseCase(repo);
    this.updateUseCase = new UpdateTagUseCase(repo);
    this.deleteUseCase = new DeleteTagUseCase(repo);
    this.assignUseCase = new AssignTagToWorkerUseCase(repo);
    this.removeUseCase = new RemoveTagFromWorkerUseCase(repo);
  }

  /** GET /api/admin/worker-tags */
  async list(_req: Request, res: Response): Promise<void> {
    try {
      const tags = await this.listUseCase.execute();
      res.status(200).json({ success: true, data: tags });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTagCatalogController:list' });
      res.status(500).json({ success: false, error: 'Failed to list tags' });
    }
  }

  /** POST /api/admin/worker-tags */
  async create(req: Request, res: Response): Promise<void> {
    const uid = getUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const parsed = CreateTagSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    try {
      const tag = await this.createUseCase.execute({ ...parsed.data, createdBy: uid });
      logger.info({ msg: 'worker-tag created', tagId: tag.id, uid });
      res.status(201).json({ success: true, data: tag });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTagCatalogController:create', uid });
      res.status(500).json({ success: false, error: 'Failed to create tag' });
    }
  }

  /** PATCH /api/admin/worker-tags/:id */
  async update(req: Request, res: Response): Promise<void> {
    const uid = getUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { id } = req.params;
    const parsed = UpdateTagSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ success: false, error: 'At least one field must be provided' });
      return;
    }

    try {
      const tag = await this.updateUseCase.execute(id, parsed.data);
      if (!tag) { res.status(404).json({ success: false, error: 'Tag not found or already deleted' }); return; }
      logger.info({ msg: 'worker-tag updated', tagId: id, uid });
      res.status(200).json({ success: true, data: tag });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTagCatalogController:update', tagId: id, uid });
      res.status(500).json({ success: false, error: 'Failed to update tag' });
    }
  }

  /** DELETE /api/admin/worker-tags/:id */
  async delete(req: Request, res: Response): Promise<void> {
    const uid = getUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { id } = req.params;
    try {
      const deleted = await this.deleteUseCase.execute(id);
      if (!deleted) { res.status(404).json({ success: false, error: 'Tag not found or already deleted' }); return; }
      logger.info({ msg: 'worker-tag soft-deleted', tagId: id, uid });
      res.status(200).json({ success: true });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTagCatalogController:delete', tagId: id, uid });
      res.status(500).json({ success: false, error: 'Failed to delete tag' });
    }
  }

  /** POST /api/admin/workers/:id/tags/:tagId */
  async assign(req: Request, res: Response): Promise<void> {
    const uid = getUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { id: workerId, tagId } = req.params;
    try {
      await this.assignUseCase.execute(workerId, tagId, uid);
      logger.info({ msg: 'worker-tag assigned', workerId, tagId, uid });
      res.status(200).json({ success: true });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.message.startsWith('Tag not found') || e.message.startsWith('Tag is deleted')) {
        res.status(404).json({ success: false, error: e.message });
        return;
      }
      reportError(e, { source: 'AdminTagCatalogController:assign', workerId, tagId, uid });
      res.status(500).json({ success: false, error: 'Failed to assign tag' });
    }
  }

  /** DELETE /api/admin/workers/:id/tags/:tagId */
  async remove(req: Request, res: Response): Promise<void> {
    const uid = getUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { id: workerId, tagId } = req.params;
    try {
      const removed = await this.removeUseCase.execute(workerId, tagId);
      if (!removed) { res.status(404).json({ success: false, error: 'Tag assignment not found' }); return; }
      logger.info({ msg: 'worker-tag removed', workerId, tagId, uid });
      res.status(200).json({ success: true });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTagCatalogController:remove', workerId, tagId, uid });
      res.status(500).json({ success: false, error: 'Failed to remove tag' });
    }
  }
}
