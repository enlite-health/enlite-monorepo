import { AsyncLocalStorage } from 'async_hooks';
import type { ActorContext } from '@shared/audit/actorSource';

export interface LogContext {
  traceId: string;
  workerId?: string;
  jobPostingId?: string;
  batchId?: string;
  /**
   * Quem está executando a request — preenchido pelo AuthMiddleware depois de
   * montar `req.user`. Lido por `withActorContext` para carimbar `changed_by` /
   * `change_source` nas trilhas de histórico sem precisar passar o ator por
   * parâmetro em cada camada.
   */
  actor?: ActorContext;
}

export const loggingAls = new AsyncLocalStorage<LogContext>();
