import { IWorkerRepository } from '../ports/IWorkerRepository';
import { Worker } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import { maskPhone } from '@shared/utils/phoneMask';
import type { IPhoneVerificationRepository, PhoneVerificationState } from '@modules/auth/ports/IPhoneVerificationRepository';

/** O que o app vê do celular verificado: estado lido da função derivada do banco, número mascarado no servidor. */
export interface PhoneVerificationView {
  state: PhoneVerificationState;
  phoneMasked: string | null;
  /** ISO 8601; só em `verified`. */
  verifiedAt: string | null;
}

export class GetWorkerProgressUseCase {
  constructor(
    private workerRepository: IWorkerRepository,
    private phoneVerification?: IPhoneVerificationRepository,
  ) {}

  async execute(authUid: string): Promise<Result<Worker>> {
    const workerResult = await this.workerRepository.findByAuthUid(authUid);
    
    if (workerResult.isFailure) {
      return Result.fail<Worker>(workerResult.error!);
    }

    const worker = workerResult.getValue();
    
    if (!worker) {
      return Result.fail<Worker>('Worker not found');
    }

    return Result.ok<Worker>(worker);
  }

  /**
   * `GET /api/workers/me` (AC-13): a ficha e o `phoneVerification`, lido da função derivada pelo repositório. Ninguém aqui lê as
   * colunas `phone_verified_*` nem decide "verificado". Sem o repositório injetado (ou leitura que falha), o estado NÃO é
   * inventado: o campo vem `null` (falha fechada, "não sei" nunca vira "verificado").
   */
  async executeWithPhoneVerification(authUid: string): Promise<Result<{ worker: Worker; phoneVerification: PhoneVerificationView | null }>> {
    const progress = await this.execute(authUid);
    if (progress.isFailure) return Result.fail(progress.error!);
    const worker = progress.getValue();
    let state: PhoneVerificationView | null = null;
    try {
      const read = await this.phoneVerification?.readState(worker.id);
      if (read) {
        state = {
          state: read.state,
          phoneMasked: read.state === 'no_phone' || !read.phone ? null : maskPhone(read.phone),
          verifiedAt: read.state === 'verified' && read.verifiedAt ? read.verifiedAt.toISOString() : null,
        };
      }
    } catch {
      state = null;
    }
    return Result.ok({ worker, phoneVerification: state });
  }
}
