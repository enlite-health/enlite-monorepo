import { Worker, WorkerStatus, CreateWorkerDTO, UpdateWorkerStepDTO, SavePersonalInfoDTO } from '../domain/Worker';
import { Result } from '@shared/utils/Result';

export interface IWorkerRepository {
  create(data: CreateWorkerDTO): Promise<Result<Worker>>;
  findById(id: string): Promise<Result<Worker | null>>;
  findByAuthUid(authUid: string): Promise<Result<Worker | null>>;
  findByEmail(email: string): Promise<Result<Worker | null>>;
  findByPhone(phone: string): Promise<Result<Worker | null>>;
  findByPhoneCandidates(candidates: string[]): Promise<Result<Worker | null>>;
  updatePersonalInfo(data: Omit<SavePersonalInfoDTO, 'termsAccepted' | 'privacyAccepted'> & {
    termsAccepted: boolean;
    privacyAccepted: boolean;
  }): Promise<Result<Worker>>;
  updateAuthUid(workerId: string, authUid: string, phone?: string, consentAt?: Date): Promise<Result<Worker>>;
  updateImportedWorkerData(workerId: string, data: { authUid: string; email: string; consentAt?: Date }): Promise<Result<Worker>>;
  updateStatus(workerId: string, status: WorkerStatus): Promise<void>;
  /** Retorna o novo status se houve mudança, ou null se inalterado / DISABLED. */
  recalculateStatus(workerId: string): Promise<WorkerStatus | null>;
  delete(workerId: string): Promise<Result<void>>;
  deleteByAuthUid(authUid: string): Promise<Result<void>>;
  /** Marca/desmarca worker como conta de teste. Retorna o flag resultante, ou null se não existir. */
  updateTestFlag(workerId: string, isTest: boolean): Promise<boolean | null>;
  /**
   * Ids de todos os workers ABSORVIDOS (mesmo `country`, cadeia até 10 saltos)
   * cuja corrente `merged_into_id` termina em `survivorId`. Ver
   * `@shared/database/findAbsorbedWorkerIds` — usado para o sobrevivente
   * abrir/apagar documento cujo caminho no GCS ainda carrega o id absorvido.
   */
  findAbsorbedWorkerIds(survivorId: string): Promise<string[]>;
}
