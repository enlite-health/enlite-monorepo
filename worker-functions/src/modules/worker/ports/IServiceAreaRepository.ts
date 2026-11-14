import { WorkerServiceArea, CreateServiceAreaDTO } from '../domain/WorkerServiceArea';
import { Result } from '@shared/utils/Result';

export interface IServiceAreaRepository {
  create(data: CreateServiceAreaDTO): Promise<Result<WorkerServiceArea>>;
  replaceByWorkerId(data: CreateServiceAreaDTO): Promise<Result<WorkerServiceArea>>;
  findByWorkerId(workerId: string): Promise<Result<WorkerServiceArea[]>>;
  deleteByWorkerId(workerId: string): Promise<Result<void>>;
  deleteByWorkerId(workerId: string): Promise<Result<void>>;
}
