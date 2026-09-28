import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import {
  GetPatientItineraryUseCase,
  PatientNotFoundForItineraryError,
  type PatientItineraryResult,
} from '../../application/GetPatientItineraryUseCase';

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
 * Sem log de acesso a recurso do paciente: o corpo não devolve nome/telefone do paciente, nem telefone do prestador.
 * Fase 12 (DX-12.5 (5)): cada alocação traz `allocationId` e `displayName` — o nome do prestador SÓ
 * de alocação vigente, projetado por `worker_contact:read` (`req.permissionCells`, decidido antes
 * do KMS) e, quando atravessa, gravado na trilha de contato (`emitirTrilhaDeContato`) — a mesma
 * régua do quadro C e das opções de alocação.
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
      const data = await this.useCase.execute(params.data.id, new Date(), req.permissionCells ?? null);
      emitirTrilhaDeContato(req, this.namedWorkerIds(data));
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

  /** Os `workerId` distintos das alocações cujo `displayName` saiu NÃO-nulo — só esses entram na trilha. */
  private namedWorkerIds(data: PatientItineraryResult): string[] {
    const ids = data.services.flatMap((service) =>
      service.slots.flatMap((slot) =>
        slot.assignments.filter((assignment) => assignment.displayName !== null).map((assignment) => assignment.workerId),
      ),
    );
    return [...new Set(ids)];
  }
}
