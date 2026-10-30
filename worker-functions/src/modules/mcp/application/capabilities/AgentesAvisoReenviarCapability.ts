import { z } from 'zod';
import type { AvisoPedidoService } from '../../../agentes/application/AvisoPedidoService';
import { ISO_DATA } from './agentesSchemas';

const ArgsShape = {
  agora: ISO_DATA.optional(),
};

const ArgsSchema = z.object(ArgsShape).strict();

/**
 * AgentesAvisoReenviarCapability (agentes.aviso.reenviar) — WRITE (spec 078, M3b-2, item 57).
 *
 * Reenvio ÚNICO do WhatsApp do caso GRAVE: pedido grave sem decisão há >= N horas (`SOL_AVISO_GRAVE_REENVIO_HORAS`, padrão 4) e com
 * exatamente 1 tentativa por destinatário recebe a tentativa 2. Com 2 tentativas NÃO reenvia: o pedido volta em `escalar` (canal
 * humano; nada automático). `agora` é o relógio injetável (teste). Devolve só ids e contagens.
 */
export class AgentesAvisoReenviarCapability {
  static readonly NAME = 'agentes.aviso.reenviar';
  static readonly DESCRIPTION =
    'Resend the urgent WhatsApp notice ONCE for GRAVE requests (pedidos) with no decision after N hours. Returns {reenviados, escalar:[{pedido_id}]}; requests already at 2 attempts are returned in escalar, never resent.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly avisos: Pick<AvisoPedidoService, 'reenviar'>) {}

  async execute(args: unknown, principalName?: string): Promise<{ reenviados: number; escalar: Array<{ pedido_id: string }> }> {
    if (!principalName) throw new Error('agentes.aviso.reenviar: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.avisos.reenviar(input.agora ? new Date(input.agora) : new Date());
  }
}
