import { AsyncLocalStorage } from 'async_hooks';
import type { ActorContext } from '@shared/audit/actorSource';
import type { DbSession } from '@shared/database/requestDbSession';

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
  /**
   * Sessão de banco da request (contexto de país + client fixado). Criada pelo
   * `dbSessionMiddleware` e preenchida pela borda que autentica. `import type`
   * de propósito: o tipo mora em `@shared/database` e um import de valor faria
   * ciclo com este módulo.
   */
  dbSession?: DbSession;
  /**
   * Método HTTP e rota SANITIZADA da request (`GET /api/admin/patients/:id`),
   * preenchidos pelo `dbSessionMiddleware`. Existem para o aviso de request sem
   * contexto declarado dizer QUAL endpoint precisa ser classificado antes da
   * virada da RLS — sem eles, o log da task 4.2 é uma pilha de avisos idênticos.
   *
   * A rota é sanitizada na origem (ids, telefones e afins viram `:id`): o que
   * interessa aqui é o endpoint, e um `/dedup/groups/<telefone>` no log seria
   * PII em texto claro.
   */
  requestMethod?: string;
  requestRoute?: string;
}

export const loggingAls = new AsyncLocalStorage<LogContext>();
