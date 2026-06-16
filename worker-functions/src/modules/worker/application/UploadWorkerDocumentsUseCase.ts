import { IWorkerDocumentsRepository } from '../infrastructure/WorkerDocumentsRepository';
import { IWorkerRepository } from '../ports/IWorkerRepository';
import { CreateWorkerDocumentsDTO, UpdateWorkerDocumentsDTO, WorkerDocuments } from '../domain/WorkerDocuments';
import { logger } from '@shared/logging';

export class UploadWorkerDocumentsUseCase {
  constructor(
    private workerDocumentsRepository: IWorkerDocumentsRepository,
    private workerRepository: IWorkerRepository,
  ) {}

  async execute(dto: CreateWorkerDocumentsDTO | UpdateWorkerDocumentsDTO): Promise<WorkerDocuments> {
    const log = logger.child({ workerId: dto.workerId });
    const fields = Object.keys(dto).filter((k) => k !== 'workerId').join(', ');
    log.info({ msg: '[UploadWorkerDocumentsUseCase] START', fields });

    const workerResult = await this.workerRepository.findById(dto.workerId);
    if (!workerResult.isSuccess || !workerResult.getValue()) {
      log.info({ msg: '[UploadWorkerDocumentsUseCase] FAIL: worker not found' });
      throw new Error('Worker not found');
    }

    const existing = await this.workerDocumentsRepository.findByWorkerId(dto.workerId);
    log.info({
      msg: '[UploadWorkerDocumentsUseCase] existing documents',
      found: !!existing,
      status: existing?.documentsStatus,
    });

    let documents: WorkerDocuments;

    if (existing) {
      documents = await this.workerDocumentsRepository.update(dto as UpdateWorkerDocumentsDTO);
    } else {
      documents = await this.workerDocumentsRepository.create(dto as CreateWorkerDocumentsDTO);
    }

    log.info({ msg: '[UploadWorkerDocumentsUseCase] documents saved', newStatus: documents.documentsStatus });

    await this.workerRepository.recalculateStatus(dto.workerId);

    log.info({ msg: '[UploadWorkerDocumentsUseCase] DONE', finalStatus: documents.documentsStatus });
    return documents;
  }
}
