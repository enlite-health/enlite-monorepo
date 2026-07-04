import { Pool } from 'pg';
import { logger } from '@shared/logging';
import type { DomainEventHandler } from '@shared/events/DomainEventProcessor';
import { PromoteBlockedApplicationsUseCase } from './PromoteBlockedApplicationsUseCase';

const TAG = '[PromoteBlockedApplicationsEventHandler]';

/**
 * createPromoteBlockedApplicationsHandler — handler para o evento
 * `worker.registration_completed`.
 *
 * Recebe payload { workerId }, executa PromoteBlockedApplicationsUseCase para
 * promover tentativas bloqueadas do worker (worker_blocked_applications →
 * worker_job_applications). Nunca lança para o DomainEventProcessor — o use
 * case já é tolerante por linha; o handler apenas propaga erros de payload
 * inválido (mesmo padrão de AnaCareMirrorEventHandler / QualifiedInterviewHandler).
 */
export function createPromoteBlockedApplicationsHandler(db: Pool): DomainEventHandler {
  return async (payload: Record<string, unknown>): Promise<void> => {
    const workerId = payload.workerId;
    if (typeof workerId !== 'string' || !workerId) {
      throw new Error(`${TAG} invalid payload: workerId must be a non-empty string`);
    }

    const log = logger.child({ workerId, handler: 'PromoteBlockedApplicationsEventHandler' });
    log.info({ msg: `${TAG} processing registration_completed` });

    const useCase = new PromoteBlockedApplicationsUseCase(db);
    const result = await useCase.execute(workerId);

    log.info({ msg: `${TAG} done`, result });
  };
}
