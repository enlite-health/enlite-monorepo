/**
 * AnaCareShiftsSourceReal — implementação real da porta `AnaCareShiftsSource` (F1), sobre o
 * `AnaCareSessionClient` (F2). Substitui `FakeAnaCareShiftsSource` quando a tela de horas for
 * ligada ao Ana Care de verdade (fora do escopo desta fase — só o adapter entra aqui).
 */
import type {
  AnaCareShiftsSource,
  AnaCareRetratoSourceStatus,
  ListShiftsParams,
  SourceShiftDTO,
} from '../../../anacare-hours/domain/AnaCareShiftsSource';
import type { AnaCareSessionClient } from './AnaCareSessionClient';
import { minimizeShiftDTO } from './AnaCareFieldMinimization';

export class AnaCareShiftsSourceReal implements AnaCareShiftsSource {
  constructor(private readonly client: AnaCareSessionClient) {}

  async listShifts(params: ListShiftsParams): Promise<SourceShiftDTO[]> {
    return this.client.listShifts({ month: params.month, patientId: params.patientId });
  }

  async getShift(sourceShiftId: string): Promise<SourceShiftDTO | null> {
    const raw = await this.client.getRawShift(sourceShiftId);
    if (!raw) return null;
    return minimizeShiftDTO(raw);
  }

  async getRetratoStatus(): Promise<AnaCareRetratoSourceStatus> {
    // `stale` (job de sync desatualizado) é do job da F4 — aqui só reflete o breaker (D341),
    // que já é observável nesta fase.
    return { stale: false, circuitBreakerOpen: this.client.circuitBreakerOpen };
  }
}
