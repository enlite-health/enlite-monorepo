import { EncuadreQueryRepository } from '../infrastructure/EncuadreQueryRepository';
import { logger } from '@shared/logging';

export interface CurrentInterviewDTO {
  vacancyTitle: string;
  scheduledFor: string; // ISO datetime com timezone de jp.timezone aplicado
  meetLink: string | null;
  status: 'pending';
}

export interface GetCurrentInterviewResult {
  interview: CurrentInterviewDTO | null;
}

/**
 * GetCurrentInterviewUseCase
 *
 * Retorna o próximo encuadre agendado de um worker:
 * - com interview_slot linkado
 * - resultado ainda nulo (não processado)
 * - slot no futuro (respeitando timezone da vaga)
 */
export class GetCurrentInterviewUseCase {
  private readonly repo: EncuadreQueryRepository;

  constructor() {
    this.repo = new EncuadreQueryRepository();
  }

  async execute(workerId: string): Promise<GetCurrentInterviewResult> {
    const log = logger.child({ workerId, useCase: 'GetCurrentInterviewUseCase' });
    log.info({ msg: 'fetching upcoming interview' });

    const row = await this.repo.findUpcomingByWorkerId(workerId);

    if (!row) {
      return { interview: null };
    }

    return {
      interview: {
        vacancyTitle: row.vacancyTitle,
        scheduledFor: row.scheduledFor,
        meetLink: row.meetLink,
        status: 'pending',
      },
    };
  }
}
