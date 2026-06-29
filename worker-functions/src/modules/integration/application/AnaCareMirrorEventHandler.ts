/**
 * AnaCareMirrorEventHandler — handler para o evento `worker.mirror_requested`.
 *
 * Recebe payload { workerId }, instancia o provider AnaCare e chama
 * MirrorWorkerService.mirrorOne(). O erro propaga naturalmente para o
 * DomainEventProcessor, que marca o evento como 'failed' no banco.
 *
 * Pattern: factory function (mesmo padrão de QualifiedInterviewHandler /
 * VacancyAutoInviteHandler). O provider é instanciado lazy para não
 * chamar Secret Manager em testes unitários.
 */

import { MirrorWorkerService } from './MirrorWorkerService';
import { AnaCareMirrorProvider } from '../infrastructure/anacare/AnaCareMirrorProvider';
import { AnaCareClient } from '../infrastructure/anacare/AnaCareClient';
import { logger } from '@shared/logging';
import type { DomainEventHandler } from '@shared/events/DomainEventProcessor';

const TAG = '[AnaCareMirrorEventHandler]';

export interface AnaCareMirrorHandlerDeps {
  /**
   * Factory opcional para o provider — usada em testes unitários para injetar
   * um provider fake sem chamar AnaCareClient.create() (que acessa Secret Manager).
   *
   * Em produção: não passar este argumento (usa AnaCareClient.create() / env var).
   */
  providerFactory?: () => Promise<AnaCareMirrorProvider>;
}

/**
 * Cria o handler para `worker.mirror_requested`.
 *
 * @param deps Dependências injetáveis (providerFactory opcional para testes).
 */
export function createAnaCareMirrorHandler(
  deps: AnaCareMirrorHandlerDeps = {},
): DomainEventHandler {
  return async (payload: Record<string, unknown>): Promise<void> => {
    const workerId = payload.workerId;
    if (typeof workerId !== 'string' || !workerId) {
      throw new Error(`${TAG} invalid payload: workerId must be a non-empty string`);
    }

    const log = logger.child({ workerId, handler: 'AnaCareMirrorEventHandler' });
    log.info({ msg: `${TAG} processing mirror request` });

    const providerFactory = deps.providerFactory ?? defaultProviderFactory;
    const provider = await providerFactory();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(workerId);
    log.info({ msg: `${TAG} done`, result });
  };
}

/**
 * Fábrica padrão de produção: usa AnaCareClient.create() (env var → Secret Manager).
 */
async function defaultProviderFactory(): Promise<AnaCareMirrorProvider> {
  const client = await AnaCareClient.create();
  return new AnaCareMirrorProvider(client);
}
