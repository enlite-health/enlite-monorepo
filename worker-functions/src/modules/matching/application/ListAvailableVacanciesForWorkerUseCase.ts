import { WorkerApplicationRepository } from '../infrastructure/WorkerApplicationRepository';
import { logger } from '@shared/logging';

export interface VacancyDTO {
  id: string;
  title: string;
  status: string;
  city?: string;
  startDate?: string;
  funnelStage: string;
}

export interface ListAvailableVacanciesResult {
  vacancies: VacancyDTO[];
}

/**
 * ListAvailableVacanciesForWorkerUseCase
 *
 * Lista vagas ativas (excluindo stages de rejeição) para um worker.
 * Inclui city da patient_address e search_start_date da vaga.
 */
export class ListAvailableVacanciesForWorkerUseCase {
  private readonly repo: WorkerApplicationRepository;

  constructor() {
    this.repo = new WorkerApplicationRepository();
  }

  async execute(workerId: string): Promise<ListAvailableVacanciesResult> {
    const log = logger.child({ workerId, useCase: 'ListAvailableVacanciesForWorkerUseCase' });
    log.info({ msg: 'fetching available vacancies' });

    const vacancies = await this.repo.findActiveByWorkerId(workerId);

    return { vacancies };
  }
}
