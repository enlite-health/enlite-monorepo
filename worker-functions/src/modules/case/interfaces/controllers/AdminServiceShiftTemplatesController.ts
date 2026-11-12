import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { ServiceShiftTemplateRepository } from '../../infrastructure/ServiceShiftTemplateRepository';
import { CatalogLabelTakenError } from '../../infrastructure/TherapeuticCatalogRepository';
import { ShiftTemplateItemsOverlapError } from '../../domain/serviceShiftTemplate';
import { createShiftTemplateSchema, updateShiftTemplateSchema } from '../validators/therapeuticProjectSchemas';
import { catalogItemParamsSchema, invalidBody, actorUidOf } from './catalogControllerHelpers';

/**
 * Guardias predefinidas (migration 550, spec 074) — catálogo global de modelos de turnos.
 * Controller próprio (o de projeto terapêutico já passa do teto de linhas). O repositório é
 * criado sem tocar o pool (o getter é preguiçoso).
 */
export class AdminServiceShiftTemplatesController {
  constructor(private readonly templates: ServiceShiftTemplateRepository = new ServiceShiftTemplateRepository()) {}

  /** GET /therapeutic-catalogs/service-shift-templates?includeInactive=true */
  async listShiftTemplates(req: Request, res: Response): Promise<void> {
    try {
      const items = await this.templates.list({ includeInactive: req.query.includeInactive === 'true' });
      res.status(200).json({ success: true, data: { kind: 'service-shift-templates', items } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminServiceShiftTemplatesController:listShiftTemplates' });
      res.status(500).json({ success: false, error: 'Failed to list shift templates' });
    }
  }

  /** GET /therapeutic-catalogs/service-shift-templates/options — só ativas, com os turnos (patient_services:read). */
  async listShiftTemplateOptions(_req: Request, res: Response): Promise<void> {
    try {
      const items = await this.templates.list({ includeInactive: false });
      res.status(200).json({ success: true, data: { items } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminServiceShiftTemplatesController:listShiftTemplateOptions' });
      res.status(500).json({ success: false, error: 'Failed to list shift template options' });
    }
  }

  /** POST /therapeutic-catalogs/service-shift-templates */
  async createShiftTemplate(req: Request, res: Response): Promise<void> {
    const body = createShiftTemplateSchema.safeParse(req.body);
    if (!body.success) {
      invalidBody(res, body.error);
      return;
    }
    try {
      const item = await this.templates.create({ ...body.data, actorUid: actorUidOf(req) });
      res.status(201).json({ success: true, data: item });
    } catch (err: unknown) {
      if (this.domainError(err, res)) return;
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminServiceShiftTemplatesController:createShiftTemplate' });
      res.status(500).json({ success: false, error: 'Failed to create shift template' });
    }
  }

  /** PATCH /therapeutic-catalogs/service-shift-templates/:itemId — `items` presente substitui os turnos. */
  async updateShiftTemplate(req: Request, res: Response): Promise<void> {
    const params = catalogItemParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = updateShiftTemplateSchema.safeParse(req.body);
    if (!body.success) {
      invalidBody(res, body.error);
      return;
    }
    try {
      const item = await this.templates.update(params.data.itemId, { ...body.data, actorUid: actorUidOf(req) });
      if (!item) {
        res.status(404).json({ success: false, error: 'Shift template not found' });
        return;
      }
      res.status(200).json({ success: true, data: item });
    } catch (err: unknown) {
      if (this.domainError(err, res)) return;
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminServiceShiftTemplatesController:updateShiftTemplate', itemId: params.data.itemId });
      res.status(500).json({ success: false, error: 'Failed to update shift template' });
    }
  }

  /** 409 rótulo duplicado entre ativos; 422 turnos sobrepostos. Devolve true se respondeu. */
  private domainError(err: unknown, res: Response): boolean {
    if (err instanceof CatalogLabelTakenError) {
      res.status(409).json({ success: false, error: 'An active item with this label already exists', code: err.code });
      return true;
    }
    if (err instanceof ShiftTemplateItemsOverlapError) {
      res.status(422).json({ success: false, error: 'Shift template items overlap', code: err.code });
      return true;
    }
    return false;
  }
}
