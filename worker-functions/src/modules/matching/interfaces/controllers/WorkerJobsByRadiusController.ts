import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { ListJobsByRadiusForWorkerUseCase } from '../../application/ListJobsByRadiusForWorkerUseCase';

const STATUS_BY_CODE = { INVALID_RADIUS: 400, ACCOUNT_INACTIVE: 403, NO_SERVICE_AREA: 409 } as const;

/**
 * WorkerJobsByRadiusController — `GET /api/workers/me/jobs?radius_km=` (spec 077 C-37, D661).
 * Identidade SÓ de `req.user.uid` (posto por `requireAuth()`); nenhum header de identidade é lido. Erro só por `code`
 * (FR-37: nenhum texto para tela).
 */
export class WorkerJobsByRadiusController {
  constructor(private readonly useCase: ListJobsByRadiusForWorkerUseCase = new ListJobsByRadiusForWorkerUseCase()) {}

  async listMine(req: Request, res: Response): Promise<void> {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const raw = req.query.radius_km;
    const radiusKm = typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    try {
      const out = await this.useCase.execute(uid, radiusKm);
      if (out.ok) {
        res.status(200).json({ items: out.items });
        return;
      }
      res.status(STATUS_BY_CODE[out.code]).json({ code: out.code });
    } catch (err) {
      reportError(err as Error, { source: 'WorkerJobsByRadiusController:listMine' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
