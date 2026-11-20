import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { resolveCountryScope, CountryScopeError } from '@modules/identity';
import type { CountryCode } from '@shared/domain/countryCodes';
import { currentDbContext } from '@shared/database/requestDbSession';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { ListKanbanServicesUseCase } from '../../application/ListKanbanServicesUseCase';
import { kanbanServicesQuerySchema } from '../validators/kanbanServicesSchemas';

/**
 * AdminPatientKanbanServicesController — agregado do subcard do Kanban de pacientes (fase 8,
 * Plano B, DX-8.1/8.5).
 *
 *   GET /api/admin/patients/kanban/services?country=AR|BR
 *
 * Uma chamada por carga do board (nunca uma por card, critério 6): devolve, por paciente com >= 1
 * serviço ATIVO, o par cobertas/`scheduleHours` de cada serviço contratado + o `liveVacancyId` (a
 * mesma condição de `ContractedServiceDetailMapper.ts`). Sob `patient_services:read` (DX-8.2, a
 * mesma célula do GET .../itinerary): a resposta carrega `scheduleHours`, que hoje só sai
 * sob essa célula (memória `vazamento-existente-nao-e-regua`). Sem `logResourceAccess`: nenhum id
 * de paciente sai em log — só ids, código de serviço, horas e `liveVacancyId` no corpo.
 */
export class AdminPatientKanbanServicesController {
  constructor(
    private readonly useCase: ListKanbanServicesUseCase = new ListKanbanServicesUseCase(),
    // Pool pego sob demanda (o construtor nao abre banco). Escopo de pais SEMPRE do servidor (PR-9), nunca o `?country` cru.
    private readonly resolveScope: (uid: string | undefined, requested: unknown) => Promise<{ countries: CountryCode[] }> = (uid, requested) =>
      resolveCountryScope(DatabaseConnection.getInstance().getPool(), uid, requested),
  ) {}

  /** GET /patients/kanban/services */
  async list(req: Request, res: Response): Promise<void> {
    const query = kanbanServicesQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query params' });
      return;
    }
    let countries: CountryCode[];
    try {
      countries = (await this.resolveScope(currentDbContext()?.uid, query.data.country)).countries;
    } catch (err) {
      if (err instanceof CountryScopeError) {
        res.status(err.status).json({ success: false, error: err.code, detail: err.message });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientKanbanServicesController:list:scope' });
      res.status(500).json({ success: false, error: 'Failed to resolve country scope' });
      return;
    }
    try {
      const data = await this.useCase.execute(countries);
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientKanbanServicesController:list', countries });
      res.status(500).json({ success: false, error: 'Failed to list kanban services' });
    }
  }
}
