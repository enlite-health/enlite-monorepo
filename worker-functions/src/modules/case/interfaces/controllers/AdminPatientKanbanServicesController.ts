import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { ListKanbanServicesUseCase } from '../../application/ListKanbanServicesUseCase';
import { kanbanServicesQuerySchema } from '../validators/kanbanServicesSchemas';

/**
 * AdminPatientKanbanServicesController — agregado do subcard do Kanban de pacientes (fase 8,
 * Plano B, DX-8.1/8.5).
 *
 *   GET /api/admin/patients/kanban/services?country=AR|BR
 *
 * Uma chamada por carga do board (nunca uma por card, critério 6): devolve, por paciente com >= 1
 * serviço ATIVO, o par cobertas/contratadas de cada serviço contratado + o `liveVacancyId` (a
 * mesma condição de `ContractedServiceDetailMapper.ts`). Sob `patient_services:read` (DX-8.2, a
 * mesma célula do GET .../itinerary): a resposta carrega `weekly`/`authorized`, que hoje só saem
 * sob essa célula (memória `vazamento-existente-nao-e-regua`). Sem `logResourceAccess`: nenhum id
 * de paciente sai em log — só ids, código de serviço, horas e `liveVacancyId` no corpo.
 */
export class AdminPatientKanbanServicesController {
  constructor(private readonly useCase: ListKanbanServicesUseCase = new ListKanbanServicesUseCase()) {}

  /** GET /patients/kanban/services */
  async list(req: Request, res: Response): Promise<void> {
    const query = kanbanServicesQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query params' });
      return;
    }
    const country = query.data.country ?? null;
    try {
      const data = await this.useCase.execute(country);
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientKanbanServicesController:list', country });
      res.status(500).json({ success: false, error: 'Failed to list kanban services' });
    }
  }
}
