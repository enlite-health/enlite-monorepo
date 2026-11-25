import { Result } from '@shared/utils/Result';
import { isUuid, type WorkerDeviceStatusView } from '../domain/WorkerDevice';
import type { WorkerDeviceRepository } from '../ports/WorkerDeviceRepository';

/**
 * Painel ("Celular perdido", D795): o estado do aparelho como o SERVIDOR o conhece. O painel só exibe; não deriva
 * nada (sem relógio, sem "pendente há X horas"). Quem pede é decidido na rota (célula `worker_device:revoke`).
 */
export class GetDeviceStatus {
  constructor(private readonly devices: WorkerDeviceRepository) {}

  async execute(input: { workerId: string }): Promise<Result<WorkerDeviceStatusView>> {
    if (!isUuid(input.workerId)) return Result.fail('INVALID_WORKER_ID');
    try {
      return Result.ok(await this.devices.findStatus(input.workerId));
    } catch {
      return Result.fail('GET_DEVICE_STATUS_FAILED');
    }
  }
}
