import { Request, Response } from 'express';
import { z } from 'zod';
import { SaveServiceAreaUseCase } from '../../application/SaveServiceAreaUseCase';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { ServiceAreaRepository } from '../../infrastructure/ServiceAreaRepository';
import { logger, reportError } from '@shared/logging';

/**
 * AdminWorkerServiceAreaController
 *
 * Edição administrativa do endereço/área de serviço de um worker. Apenas role
 * ADMIN (gate no middleware da rota). Reusa o MESMO SaveServiceAreaUseCase do
 * self-service do worker — incluindo recálculo de status — para manter paridade
 * com o fluxo de cadastro (Google Places + lat/lng + cidade/CEP/bairro).
 *
 * Rota (src/index.ts via createAdminWorkerRoutes, adminOnly):
 *   PUT /api/admin/workers/:id/service-area
 */

const ServiceAreaBodySchema = z
  .object({
    address: z.string().trim().min(1).max(500),
    addressComplement: z.string().trim().max(255).optional(),
    serviceRadiusKm: z.number().positive().max(500),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    city: z.string().trim().max(255).optional(),
    postalCode: z.string().trim().max(20).optional(),
    neighborhood: z.string().trim().max(255).optional(),
  })
  .strict();

function getUid(req: Request): string | null {
  return (req as Request & { user?: { uid: string } }).user?.uid ?? null;
}

export class AdminWorkerServiceAreaController {
  private readonly useCase: SaveServiceAreaUseCase;

  constructor() {
    this.useCase = new SaveServiceAreaUseCase(new WorkerRepository(), new ServiceAreaRepository());
  }

  /** PUT /api/admin/workers/:id/service-area */
  async updateServiceArea(req: Request, res: Response): Promise<void> {
    const uid = getUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { id } = req.params;
    const parsed = ServiceAreaBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    try {
      const result = await this.useCase.execute({ workerId: id, ...parsed.data });
      if (result.isFailure) {
        const notFound = result.error === 'Worker not found';
        res.status(notFound ? 404 : 400).json({ success: false, error: result.error });
        return;
      }
      logger.info({ msg: 'worker service area updated by admin', workerId: id, uid });
      res.status(200).json({ success: true, data: { message: 'Service area saved' } });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminWorkerServiceAreaController:updateServiceArea', workerId: id, uid });
      res.status(500).json({ success: false, error: 'Failed to update service area' });
    }
  }
}
