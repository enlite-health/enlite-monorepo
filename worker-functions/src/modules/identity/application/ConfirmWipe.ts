import { Result } from '@shared/utils/Result';
import { isInstallationId, isUuid } from '../domain/WorkerDevice';
import type { WorkerDeviceRepository } from '../ports/WorkerDeviceRepository';

/** O aparelho avisa que se apagou (melhor esforço). `wiped_at` é gravado uma só vez; repetir não muda nada. */
export class ConfirmWipe {
  constructor(private readonly devices: WorkerDeviceRepository) {}

  async execute(input: { workerId: string; installationId: string }): Promise<Result<{ recorded: boolean }>> {
    if (!isUuid(input.workerId)) return Result.fail('INVALID_WORKER_ID');
    if (!isInstallationId(input.installationId)) return Result.fail('INVALID_INSTALLATION_ID');
    try {
      return Result.ok({ recorded: await this.devices.confirmWipe(input.workerId, input.installationId) });
    } catch {
      return Result.fail('CONFIRM_WIPE_FAILED');
    }
  }
}
