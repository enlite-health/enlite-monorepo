/**
 * ReconcileClickUpPatientsController
 *
 * POST /api/internal/sync-clickup-patients
 * Trigger: Cloud Scheduler (gcp/scheduler/sync-patients.yaml, a cada 10 min).
 * Protegido pelo InternalAuthMiddleware, como as demais rotas internas.
 *
 * O use case é montado PREGUIÇOSAMENTE na primeira chamada: o
 * ClickUpFieldResolver.fromList faz I/O contra a API do ClickUp, e fazer isso
 * no boot acoplaria a subida do serviço à disponibilidade do ClickUp.
 * Depois de montado, fica em cache no processo.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import * as functions from 'firebase-functions';
import {
  ReconcileClickUpPatientsUseCase,
  type ReconcileMode,
} from '../../application/ReconcileClickUpPatientsUseCase';
import { SyncPatientFromClickUpTaskUseCase } from '../../application/SyncPatientFromClickUpTaskUseCase';
import {
  ClickUpTaskListGateway,
  PATIENT_LIST_ID,
} from '../../infrastructure/clickup/ClickUpTaskListGateway';
import { ClickUpFieldResolver } from '../../infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../infrastructure/clickup/ClickUpPatientMapper';
import { PatientService } from '../../../case/application/PatientService';

const QuerySchema = z.object({
  mode: z.enum(['cycle', 'incremental', 'orphans', 'full']).optional().default('cycle'),
  windowMinutes: z.coerce.number().int().positive().max(1440).optional().default(30),
});

export class ReconcileClickUpPatientsController {
  private useCase: ReconcileClickUpPatientsUseCase | null = null;
  private building: Promise<ReconcileClickUpPatientsUseCase> | null = null;

  constructor(private readonly useCaseFactory: () => Promise<ReconcileClickUpPatientsUseCase> = buildUseCase) {}

  async handle(req: Request, res: Response): Promise<void> {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', issues: parsed.error.issues });
      return;
    }
    const { mode, windowMinutes } = parsed.data;

    try {
      const useCase = await this.getUseCase();
      const outcome = await useCase.execute({ mode: mode as ReconcileMode, windowMinutes });

      if (outcome.kind === 'BUSY') {
        res.status(409).json({ error: 'already_running' });
        return;
      }

      res.status(200).json({ status: 'ok', ...outcome.counters });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      functions.logger.error('reconcile.request_failed', { mode, error: message });
      res.status(500).json({ error: 'reconcile_failed', message });
    }
  }

  /** Constrói uma vez e reusa; chamadas concorrentes compartilham a mesma promise. */
  private async getUseCase(): Promise<ReconcileClickUpPatientsUseCase> {
    if (this.useCase) return this.useCase;
    if (!this.building) {
      this.building = this.useCaseFactory()
        .then(uc => {
          this.useCase = uc;
          return uc;
        })
        .catch(err => {
          this.building = null; // permite nova tentativa no próximo request
          throw err;
        });
    }
    return this.building;
  }
}

async function buildUseCase(): Promise<ReconcileClickUpPatientsUseCase> {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN missing');

  const resolver = await ClickUpFieldResolver.fromList(PATIENT_LIST_ID, { token });
  const mapper = new ClickUpPatientMapper(resolver);

  return new ReconcileClickUpPatientsUseCase({
    gateway: new ClickUpTaskListGateway(token),
    syncUseCase: new SyncPatientFromClickUpTaskUseCase({
      mapper,
      patientService: new PatientService(),
    }),
  });
}
