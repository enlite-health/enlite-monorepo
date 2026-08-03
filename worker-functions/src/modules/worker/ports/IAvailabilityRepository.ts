import { WorkerAvailability, CreateAvailabilityDTO } from '../domain/WorkerAvailability';
import { Result } from '@shared/utils/Result';

export interface IAvailabilityRepository {
  create(data: CreateAvailabilityDTO): Promise<Result<WorkerAvailability>>;
  findByWorkerId(workerId: string): Promise<Result<WorkerAvailability[]>>;
  deleteByWorkerId(workerId: string): Promise<Result<void>>;
  createBatch(data: CreateAvailabilityDTO[]): Promise<Result<void>>;
  /** Substitui TODOS os slots do worker (delete + insert) numa transação única. */
  replaceByWorkerId(workerId: string, data: CreateAvailabilityDTO[]): Promise<Result<void>>;
}
