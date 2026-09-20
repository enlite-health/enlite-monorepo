import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { SaveServiceAreaUseCase } from '../../application/SaveServiceAreaUseCase';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { ServiceAreaRepository } from '../../infrastructure/ServiceAreaRepository';
import { WorkerAuditRepository, extractWorkerAuditActor } from '../../infrastructure/WorkerAuditRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger, reportError } from '@shared/logging';

/**
 * AdminWorkerServiceAreaController
 *
 * Edição administrativa do endereço/área de serviço de um worker. Apenas role
 * ADMIN (gate no middleware da rota). Reusa o MESMO SaveServiceAreaUseCase do
 * self-service do worker — incluindo recálculo de status — para manter paridade
 * com o fluxo de cadastro (Google Places + lat/lng + cidade/CEP/bairro).
 *
 * Rota (src/index.ts via createAdminWorkerRoutes, `worker:write`; papel `admin` só até a família virar):
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
  private readonly auditRepo: WorkerAuditRepository;
  private readonly pool: Pool;

  constructor() {
    this.useCase = new SaveServiceAreaUseCase(new WorkerRepository(), new ServiceAreaRepository());
    this.auditRepo = new WorkerAuditRepository();
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /** Snapshot da área de serviço primária atual (para o "antes" da auditoria). */
  private async currentArea(workerId: string): Promise<Record<string, unknown> | null> {
    try {
      const r = await this.pool.query(
        `SELECT address_line AS address, address_complement AS "addressComplement",
                neighborhood, city, postal_code AS "postalCode", state,
                latitude AS lat, longitude AS lng, radius_km AS "serviceRadiusKm"
         FROM worker_service_areas WHERE worker_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [workerId],
      );
      return r.rows[0] ?? null;
    } catch {
      return null; // best-effort: "antes" da auditoria não bloqueia a edição
    }
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
      const before = await this.currentArea(id);
      const result = await this.useCase.execute({ workerId: id, ...parsed.data });
      if (result.isFailure) {
        const notFound = result.error === 'Worker not found';
        res.status(notFound ? 404 : 400).json({ success: false, error: result.error });
        return;
      }
      logger.info({ msg: 'worker service area updated by admin', workerId: id, uid });
      await this.auditRepo.recordFieldChanges({
        workerId: id,
        fields: [{ field: 'serviceArea', before, after: parsed.data }],
        actor: extractWorkerAuditActor(req),
      });
      res.status(200).json({ success: true, data: { message: 'Service area saved' } });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminWorkerServiceAreaController:updateServiceArea', workerId: id, uid });
      res.status(500).json({ success: false, error: 'Failed to update service area' });
    }
  }
}
