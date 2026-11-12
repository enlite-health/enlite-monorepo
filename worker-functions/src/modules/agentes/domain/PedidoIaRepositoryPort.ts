import type { DecisaoInput, FiltroPedidos, PedidoIa, PedidoStatus } from './PedidoIa';

export interface PedidoIaRepositoryPort {
  listar(filtro: FiltroPedidos): Promise<PedidoIa[]>;
  obter(id: string): Promise<PedidoIa | null>;
  /**
   * Grava UM evento preso à atitude de maior `versao` do pedido, numa transação.
   * @throws PedidoNaoEncontradoError | DecisaoJaRegistradaError
   */
  decidir(input: DecisaoInput): Promise<{ evento_id: string; status: PedidoStatus }>;
}
