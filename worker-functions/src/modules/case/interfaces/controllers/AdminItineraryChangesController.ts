import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { ItineraryChangeLogReader } from '../../infrastructure/ItineraryChangeLogReader';
import { itineraryServiceParamsSchema } from '../validators/itineraryWriteSchemas';

/**
 * AdminItineraryChangesController — leitura do registro de trocas do itinerário (C9, change
 * itinerario-trocas-motivos-e-figma, Fase 2):
 *
 *   GET /api/admin/patients/:id/contracted-services/:sid/itinerary/changes
 *
 * Sob `patient_services:read` (a mesma do GET do itinerário). Sem lógica de negócio: valida forma
 * (zod), lê e devolve `{ changes: [...] }`. Nenhum nome de prestador sai daqui (pessoa só por id) —
 * por isso não há trilha de contato. Serviço inexistente/de outro paciente/fora da RLS → 404 sem
 * distinguir. `reportError` nunca leva id de prestador.
 */
export class AdminItineraryChangesController {
  constructor(private readonly reader: ItineraryChangeLogReader = new ItineraryChangeLogReader()) {}

  /** GET .../contracted-services/:sid/itinerary/changes */
  async list(req: Request, res: Response): Promise<void> {
    const params = itineraryServiceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const { id: patientId, sid: serviceId } = params.data;
    try {
      const changes = await this.reader.listByService(patientId, serviceId);
      if (changes === null) {
        res.status(404).json({ success: false, code: 'NOT_FOUND' });
        return;
      }
      res.status(200).json({ success: true, data: { changes } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminItineraryChangesController:list', patientId, serviceId });
      res.status(500).json({ success: false, error: 'Failed to list itinerary changes' });
    }
  }
}
