import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { GetPatientItineraryUseCase, PatientNotFoundForItineraryError } from '../../application/GetPatientItineraryUseCase';

const patientParamsSchema = z.object({ id: z.string().uuid() });

/**
 * AdminPatientItineraryController — leitura do itinerário (fase 7, DX-7.6/7.7).
 *
 *   GET /api/admin/patients/:id/itinerary
 *
 * Sob `patient_services:read` (Q-7.3, padrão fixado na DX-7.7): a resposta carrega os mesmos
 * `weeklyHours`/`authorizedHours` (rotulados `contratadas.weekly`/`.authorized`) que hoje só saem
 * por essa célula (`adminPatientsRoutes.ts:240`, GET .../contracted-services) — sob `patient:read`
 * a rota abriria esses números a quem hoje não os lê (memória `vazamento-existente-nao-e-regua`).
 * Sem `logResourceAccess`: o corpo não devolve nome/telefone do paciente nem do prestador — só
 * ids, horas, datas e status —, a mesma régua do GET irmão de serviços contratados.
 */
export class AdminPatientItineraryController {
  constructor(private readonly useCase: GetPatientItineraryUseCase = new GetPatientItineraryUseCase()) {}

  /** GET /api/admin/patients/:id/itinerary */
  async get(req: Request, res: Response): Promise<void> {
    const params = patientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      const data = await this.useCase.execute(params.data.id);
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      if (err instanceof PatientNotFoundForItineraryError) {
        res.status(404).json({ success: false, code: 'NOT_FOUND' });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientItineraryController:get', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to get patient itinerary' });
    }
  }
}
