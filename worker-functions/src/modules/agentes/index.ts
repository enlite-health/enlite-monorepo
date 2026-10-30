/** agentes module — barrel (spec 078, M3b-1): pedidos do Sol para a página de gestores. */
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PostgresPedidoIaRepository } from './infrastructure/PostgresPedidoIaRepository';
import { DecidirPedidoIaUseCase, ListarPedidosIaUseCase, ObterPedidoIaUseCase } from './application/PedidosIaUseCases';
import { PedidoAplicarNotifier } from './infrastructure/PedidoAplicarNotifier';
import { reportError } from '@shared/logging';
import { PedidoIaController } from './interfaces/controllers/PedidoIaController';

export { createAdminPedidosIaRoutes } from './interfaces/routes/adminPedidosIaRoutes';
export { PedidoIaController } from './interfaces/controllers/PedidoIaController';

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
