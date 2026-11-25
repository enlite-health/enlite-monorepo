import { Result } from '@shared/utils/Result';
import { isUuid, type ActiveWorkerDevice } from '../domain/WorkerDevice';
import type { WorkerDeviceRepository } from '../ports/WorkerDeviceRepository';

/** Serve ao BFF: qual é o aparelho ativo da cuidadora (id da instalação + chave pública). Nunca devolve o token FCM. */
export class GetDevice {
  constructor(private readonly devices: WorkerDeviceRepository) {}

  async execute(input: { workerId: string }): Promise<Result<ActiveWorkerDevice | null>> {
    if (!isUuid(input.workerId)) return Result.fail('INVALID_WORKER_ID');
    try {
      return Result.ok(await this.devices.findActive(input.workerId));
    } catch {
      return Result.fail('GET_DEVICE_FAILED');
    }
  }
}
