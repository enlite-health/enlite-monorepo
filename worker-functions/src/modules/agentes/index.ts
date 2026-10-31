/** agentes module — barrel (spec 078, M3b-1): pedidos do Sol para a página de gestores. */
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PostgresPedidoIaRepository } from './infrastructure/PostgresPedidoIaRepository';
import { DecidirPedidoIaUseCase, ListarPedidosIaUseCase, ObterPedidoIaUseCase } from './application/PedidosIaUseCases';
import { PedidoAplicarNotifier } from './infrastructure/PedidoAplicarNotifier';
import { reportError } from '@shared/logging';
import { PedidoIaController } from './interfaces/controllers/PedidoIaController';
import { AssistentesPlataformaController } from './interfaces/controllers/AssistentesPlataformaController';
import { AlcanceAssistentesUseCase, type ResolverCelulasDoAtor } from './application/AlcanceAssistentesUseCase';
import { withActorContext } from '@shared/database/actorContext';
import { staffActor } from '@shared/audit/actorSource';
import { lerPlacarCom, registrarReporteCom } from '../mcp/infrastructure/AgentesRepository';

export { createAdminPedidosIaRoutes } from './interfaces/routes/adminPedidosIaRoutes';
export { PedidoIaController } from './interfaces/controllers/PedidoIaController';
export { createAdminAssistentesRoutes } from './interfaces/routes/adminAssistentesRoutes';
export { AssistentesPlataformaController } from './interfaces/controllers/AssistentesPlataformaController';

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
  );
}

/**
 * Composition root das rotas de assistentes (spec 080). `resolverCelulas` = a mesma resolução do `GetMyAuthzUseCase`
 * (o wiring de `src/index.ts` injeta; falha propaga -> 500, nunca lista vazia). OPERADOR_LIVRE: o placar aceita qualquer operador.
 */
export function createAssistentesPlataformaController(resolverCelulas: ResolverCelulasDoAtor): AssistentesPlataformaController {
  const pool = DatabaseConnection.getInstance().getPool();
  return new AssistentesPlataformaController({
    alcance: new AlcanceAssistentesUseCase(resolverCelulas),
    resolverCelulas,
    lerPlacar: (uid, p) => withActorContext(pool, (c) => lerPlacarCom(c, p), staffActor(uid)),
    registrarReporte: (uid, r) => withActorContext(pool, (c) => registrarReporteCom(c, r), staffActor(uid)),
  });
}
