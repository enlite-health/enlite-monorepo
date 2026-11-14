import { IWorkerRepository } from '../ports/IWorkerRepository';
import { IServiceAreaRepository } from '../ports/IServiceAreaRepository';
import { SaveServiceAreaDTO, Worker } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import type { WorkerServiceArea } from '../domain/WorkerServiceArea';
import { APP_CHANNEL, type ProfileEditAttribution } from '../domain/profileEditSource';
import { changedFields, recordProfileEditTrail } from './profileEditTrail';

export class SaveServiceAreaUseCase {
  constructor(
    private workerRepository: IWorkerRepository,
    private serviceAreaRepository: IServiceAreaRepository,
  ) {}

  async execute(data: SaveServiceAreaDTO, attribution: ProfileEditAttribution): Promise<Result<Worker>> {
    const workerResult = await this.workerRepository.findById(data.workerId);
    
    if (workerResult.isFailure) {
      return Result.fail<Worker>(workerResult.error!);
    }

    const worker = workerResult.getValue();
    if (!worker) {
      return Result.fail<Worker>('Worker not found');
    }

    // "Antes" da trilha (FR-53), lido ANTES da troca. undefined = leitura falhou (trilha pulada); null = não havia zona.
    const before = await this.readBeforeSafe(data.workerId);

    // O app (BFF) não envia o complemento: ausente = manter o que a Web gravou. Web/admin mandam o
    // formulário inteiro e omitem o campo para apagá-lo (ServiceAddressTab / WorkerEditModal): ausente = apagar.
    const keepComplement = attribution.channel === APP_CHANNEL;

    const createResult = await this.serviceAreaRepository.replaceByWorkerId({
      workerId: data.workerId,
      address: data.address,
      addressComplement: keepComplement ? data.addressComplement : (data.addressComplement ?? null),
      serviceRadiusKm: data.serviceRadiusKm,
      lat: data.lat,
      lng: data.lng,
      city: data.city,
      postalCode: data.postalCode,
      neighborhood: data.neighborhood,
    });

    if (createResult.isFailure) {
      return Result.fail<Worker>(createResult.error!);
    }

    if (before !== undefined) {
      await recordProfileEditTrail(data.workerId, changedFields([
        ['serviceAddress', before?.address, data.address],
        ['serviceRadiusKm', before?.serviceRadiusKm, data.serviceRadiusKm],
      ]), attribution);
    }

    await this.workerRepository.recalculateStatus(data.workerId);

    return Result.ok<Worker>(worker);
  }

  private async readBeforeSafe(workerId: string): Promise<WorkerServiceArea | null | undefined> {
    try {
      const r = await this.serviceAreaRepository.findByWorkerId(workerId);
      if (r.isFailure) return undefined;
      return r.getValue()[0] ?? null;
    } catch {
      return undefined;
    }
  }
}
