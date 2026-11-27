import { Result } from '@shared/utils/Result';
import { IWorkerRepository } from '../ports/IWorkerRepository';

/** Apaga a foto de perfil da própria prestadora (D815). `workerId` vem do token, nunca do corpo. Idempotente. */
export class ClearProfilePhotoUseCase {
  constructor(private readonly workerRepository: IWorkerRepository) {}

  async execute(workerId: string): Promise<Result<void>> {
    return this.workerRepository.clearProfilePhoto(workerId);
  }
}
