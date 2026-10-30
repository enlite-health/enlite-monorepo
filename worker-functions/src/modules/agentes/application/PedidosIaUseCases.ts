import {
  ComentarioObrigatorioError,
  MotivoObrigatorioError,
  PedidoNaoEncontradoError,
  type AcaoDecisao,
  type FiltroPedidos,
  type PedidoIa,
  type PedidoStatus,
} from '../domain/PedidoIa';
import type { PedidoIaRepositoryPort } from '../domain/PedidoIaRepositoryPort';

/** Leitura: lista e um pedido. Nunca escreve (item 51: ver não deixa evento). */
export class ListarPedidosIaUseCase {
  constructor(private readonly repo: PedidoIaRepositoryPort) {}
  execute(filtro: FiltroPedidos): Promise<PedidoIa[]> {
    return this.repo.listar(filtro);
  }
}

export class ObterPedidoIaUseCase {
  constructor(private readonly repo: PedidoIaRepositoryPort) {}
  async execute(id: string): Promise<PedidoIa> {
    const p = await this.repo.obter(id);
    if (!p) throw new PedidoNaoEncontradoError();
    return p;
  }
}

export interface DecidirPedidoIaInput {
  pedidoId: string;
  acao: AcaoDecisao;
  actorUid: string;
  motivo?: string;
  comentario?: string;
}

/**
 * Aceitar / negar / descrever. Valida a obrigatoriedade ANTES do banco (o banco também recusa por CHECK):
 * negar exige `motivo`, descrever exige `comentario`. `descrever` NÃO cria atitude nova — é o Sol que redige a v2.
 * A restrição por área/nível de acesso é da M6 (aqui a célula `pedidos_ia:decidir` é a única trava).
 */
export class DecidirPedidoIaUseCase {
  constructor(private readonly repo: PedidoIaRepositoryPort) {}

  async execute(i: DecidirPedidoIaInput): Promise<{ evento_id: string; status: PedidoStatus }> {
    const motivo = i.motivo?.trim();
    const comentario = i.comentario?.trim();
    if (i.acao === 'negar' && !motivo) throw new MotivoObrigatorioError();
    if (i.acao === 'descrever' && !comentario) throw new ComentarioObrigatorioError();
    return this.repo.decidir({
      pedidoId: i.pedidoId,
      acao: i.acao,
      actorUid: i.actorUid,
      ...(i.acao === 'negar' ? { motivo } : {}),
      ...(i.acao === 'descrever' ? { comentario } : {}),
    });
  }
}
