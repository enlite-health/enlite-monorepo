import { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { reportError } from '@shared/logging';
import { operationDateInZone } from '@shared/locale/operationDate';
import type { GetWorkerTransitToPatientUseCase } from '../../application/GetWorkerTransitToPatientUseCase';

const STATUS_BY_CODE = { ACCOUNT_INACTIVE: 403, ADDRESS_NOT_AVAILABLE: 404, NO_SERVICE_AREA: 409 } as const;

/** UTC−3 (Buenos Aires): o "hoje" do recorte [hoje, hoje+7] do FR-44, igual ao do itinerário. */
const TODAY_ZONE = 'America/Argentina/Buenos_Aires';

/**
 * 30 consultas por hora por prestador (FR-46: ~2 aberturas por dia): teto próprio para a chamada paga ao Google (D669, custo
 * ≈ 0). Chave por uid, não por IP: atrás do balanceador todos chegam com o mesmo IP (mesma régua do `corridorRateLimit`).
 */
export const workerTransitRateLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED' },
  keyGenerator: (req: Request) => {
    const uid = req.user?.uid;
    if (uid) return `worker:${uid}`;
    return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
});

/**
 * WorkerTransitMeController — `GET /api/workers/me/patients/:patientRef/transit` (spec 077 FR-46, D659).
 * Identidade SÓ de `req.user.uid` (posto por `requireAuth()`); nenhum header de identidade é lido. Erro só por `code` (FR-37).
 * O use case vem montado de fora (`createGetWorkerTransitToPatientUseCase`, em `src/index.ts`).
 */
export class WorkerTransitMeController {
  constructor(
    private readonly useCase: GetWorkerTransitToPatientUseCase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMine(req: Request, res: Response): Promise<void> {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    try {
      const out = await this.useCase.execute(uid, String(req.params.patientRef), operationDateInZone(TODAY_ZONE, this.now()));
      if (out.ok) {
        res.status(200).json({ origin_label: out.origin_label, routes: out.routes });
        return;
      }
      res.status(STATUS_BY_CODE[out.code]).json({ code: out.code });
    } catch (err) {
      reportError(err as Error, { source: 'WorkerTransitMeController:getMine' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
