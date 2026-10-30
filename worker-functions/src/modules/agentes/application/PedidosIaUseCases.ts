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

/** Gatilho (d) (spec 078 M4.4): porta que avisa os decisores de que um pedido aceito em degrau 3/4 aguarda aplicação. */
export interface AvisoAplicarPort {
  notificar(i: { pedidoId: string; degrau: number; grave: boolean }): Promise<void>;
}

/** Degraus que mudam código ou interruptor (a regra no registro é 0-2): aceitar um deles gera trabalho de aplicar. */
export const DEGRAUS_A_APLICAR: readonly number[] = [3, 4];

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
  constructor(
    private readonly repo: PedidoIaRepositoryPort,
    private readonly avisoAplicar?: AvisoAplicarPort,
    private readonly onErro?: (err: unknown, fonte: string) => void,
  ) {}

  async execute(i: DecidirPedidoIaInput): Promise<{ evento_id: string; status: PedidoStatus }> {
    const motivo = i.motivo?.trim();
    const comentario = i.comentario?.trim();
    if (i.acao === 'negar' && !motivo) throw new MotivoObrigatorioError();
    if (i.acao === 'descrever' && !comentario) throw new ComentarioObrigatorioError();
    const out = await this.repo.decidir({
      pedidoId: i.pedidoId,
      acao: i.acao,
      actorUid: i.actorUid,
      ...(i.acao === 'negar' ? { motivo } : {}),
      ...(i.acao === 'descrever' ? { comentario } : {}),
    });
    if (i.acao === 'aceitar') await this.avisarAplicar(i.pedidoId);
    return out;
  }

  /**
   * Gatilho (d): DEPOIS do commit da decisão (o aceite nunca se desfaz por falha do aviso). A falha é reportada (sem texto do pedido),
   * não engolida em silêncio. Degrau lido da atitude atual do pedido, o mesmo que a decisão acabou de aceitar.
   */
  private async avisarAplicar(pedidoId: string): Promise<void> {
    if (!this.avisoAplicar) return;
    try {
      const p = await this.repo.obter(pedidoId);
      const degrau = p?.atitude_atual?.degrau;
      if (!p || degrau === undefined || !DEGRAUS_A_APLICAR.includes(degrau)) return;
      await this.avisoAplicar.notificar({ pedidoId, degrau, grave: p.grave_gatilho !== 'nenhum' });
    } catch (err) {
      this.onErro?.(err, 'DecidirPedidoIaUseCase:avisarAplicar');
    }
  }
}
