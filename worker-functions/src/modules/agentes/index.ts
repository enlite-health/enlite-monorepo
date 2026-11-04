/** agentes module — barrel (spec 078, M3b-1): pedidos do Sol para a página de gestores. */
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PostgresPedidoIaRepository } from './infrastructure/PostgresPedidoIaRepository';
import { DecidirPedidoIaUseCase, ListarPedidosIaUseCase, ObterPedidoIaUseCase } from './application/PedidosIaUseCases';
import { PedidoAplicarNotifier } from './infrastructure/PedidoAplicarNotifier';
import { reportError } from '@shared/logging';
import { PedidoIaController } from './interfaces/controllers/PedidoIaController';
import { AssistantsPlatformController } from './interfaces/controllers/AssistantsPlatformController';
import { AssistantReachUseCase, type ResolveActorCells } from './application/AssistantReachUseCase';
import { withActorContext } from '@shared/database/actorContext';
import { staffActor } from '@shared/audit/actorSource';
import { consultarContadoresPedidos } from './infrastructure/PedidoContadorQuery';
import { AssistantCountService } from './application/AssistantCountService';
import { WorkerCountReader } from './infrastructure/WorkerCountReader';
import { PatientCountReader } from './infrastructure/PatientCountReader';
import { VacancyCountReader } from './infrastructure/VacancyCountReader';
import { readScoreboardWith, registerEscalationWith } from '../mcp/infrastructure/AgentesRepository';

export { createAdminPedidosIaRoutes } from './interfaces/routes/adminPedidosIaRoutes';
export { PedidoIaController } from './interfaces/controllers/PedidoIaController';
export { AssistantCountService } from './application/AssistantCountService';
export { createAdminAssistantsRoutes } from './interfaces/routes/adminAssistantsRoutes';
export { AssistantsPlatformController } from './interfaces/controllers/AssistantsPlatformController';

/** Composition root do módulo (usa `getPool()`: a RLS exige o contexto de país/uid da request). */
export function createPedidoIaController(): PedidoIaController {
  const pool = DatabaseConnection.getInstance().getPool();
  const repo = new PostgresPedidoIaRepository(pool);
  // Só a fonte: o erro não carrega texto do pedido.
  const onErro = (err: unknown, fonte: string) => reportError(err instanceof Error ? new Error(err.name) : new Error('erro'), { source: fonte });
  return new PedidoIaController(
    new ListarPedidosIaUseCase(repo),
    new ObterPedidoIaUseCase(repo),
    new DecidirPedidoIaUseCase(repo, new PedidoAplicarNotifier(pool), onErro),
    (uid, janela) => withActorContext(pool, (c) => consultarContadoresPedidos(c, janela), staffActor(uid)),
  );
}

/**
 * Composition root of the assistants routes (spec 080). `resolveCells` = the same resolution as `GetMyAuthzUseCase`
 * (the wiring in `src/index.ts` injects it; a failure propagates -> 500, never an empty list). FREE OPERATOR: the scoreboard accepts any operator.
 */
export function createAssistantsPlatformController(resolveCells: ResolveActorCells): AssistantsPlatformController {
  const pool = DatabaseConnection.getInstance().getPool();
  return new AssistantsPlatformController({
    reach: new AssistantReachUseCase(resolveCells),
    resolveCells,
    readScoreboard: (uid, p) => withActorContext(pool, (c) => readScoreboardWith(c, p), staffActor(uid)),
    registerEscalation: (uid, e) => withActorContext(pool, (c) => registerEscalationWith(c, e), staffActor(uid)),
  });
}

/** Composition root da contagem da Maria (change 085): as três entidades rodam em `withActorContext` com o ator da request (F-db-2). */
export function createAssistantCountService(): AssistantCountService {
  const pool = DatabaseConnection.getInstance().getPool();
  return new AssistantCountService((actor, fn) =>
    withActorContext(
      pool,
      (client) => fn({ workers: new WorkerCountReader(client), patients: new PatientCountReader(client), vacancies: new VacancyCountReader(client) }),
      actor,
    ),
  );
}
