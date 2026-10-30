/**
 * Domínio dos pedidos do Sol/gestores (spec 078, M3b-1). A tabela `agentes.pedido_eventos` é a auditoria da decisão
 * (item 51); o STATUS nunca é coluna — é a view `agentes.pedido_status` (último evento).
 */
export const PEDIDO_STATUS = ['novo', 'aceito', 'negado', 'redirecionado'] as const;
export type PedidoStatus = (typeof PEDIDO_STATUS)[number];

export type AcaoDecisao = 'aceitar' | 'negar' | 'descrever';

export interface PedidoAtitude {
  versao: number;
  degrau: number;
  conteudo: string;
  caso_teste: string;
  metrica_alvo: string;
  janela: string;
  gatilho_rollback: string;
}

export interface PedidoEvento {
  acao: AcaoDecisao;
  actor_uid: string;
  actor_kind: 'humano' | 'agente' | 'sistema';
  ts: string;
  motivo?: string;
  comentario?: string;
}

export interface PedidoIa {
  id: string;
  assunto: string;
  autor: string;
  area: string;
  grave_gatilho: string;
  status: PedidoStatus;
  criado_em: string;
  idade_h: number;
  atitude_atual: PedidoAtitude | null;
  eventos: PedidoEvento[];
}

export interface FiltroPedidos {
  area?: string;
  status?: PedidoStatus;
  /** true = só os de gatilho grave (`grave_gatilho <> 'nenhum'`); false = só os sem gatilho. */
  grave?: boolean;
}

export interface DecisaoInput {
  pedidoId: string;
  acao: AcaoDecisao;
  actorUid: string;
  motivo?: string;
  comentario?: string;
}

export class PedidoNaoEncontradoError extends Error {
  constructor() { super('PEDIDO_NAO_ENCONTRADO'); this.name = 'PedidoNaoEncontradoError'; }
}
export class MotivoObrigatorioError extends Error {
  constructor() { super('MOTIVO_OBRIGATORIO'); this.name = 'MotivoObrigatorioError'; }
}
export class ComentarioObrigatorioError extends Error {
  constructor() { super('COMENTARIO_OBRIGATORIO'); this.name = 'ComentarioObrigatorioError'; }
}
/** A atitude já tem uma decisão (aceitar OU negar): índice único parcial do banco. */
export class DecisaoJaRegistradaError extends Error {
  constructor() { super('DECISAO_JA_REGISTRADA'); this.name = 'DecisaoJaRegistradaError'; }
}
