import { z } from 'zod';
import type { AgentesRepository } from '../../infrastructure/AgentesRepository';
import { AREA, AUTOR, GRAVE_GATILHOS, UUID, ref, texto } from './agentesSchemas';

const AtitudeShape = {
  degrau: z.number().int().min(0).max(4),
  conteudo: texto(4000),
  caso_teste: texto(1000),
  metrica_alvo: texto(120),
  janela: texto(80),
  gatilho_rollback: texto(300),
};

const OrigemSchema = z.union([
  z.object({ reporte_id: UUID }).strict(),
  z.object({ veredicto_id: UUID }).strict(),
]);

const ArgsShape = {
  assunto: texto(200),
  descricao: texto(1000),
  autor: AUTOR,
  area: AREA,
  grave_gatilho: z.enum(GRAVE_GATILHOS),
  registro_versao: ref(1, 40),
  atitude: z.object(AtitudeShape).strict(),
  origens: z.array(OrigemSchema).min(1).max(100),
};

const ArgsSchema = z.object(ArgsShape).strict();

/**
 * AgentesPedidoDepositarCapability (agentes.pedido.depositar) — WRITE.
 *
 * A fila deposita o pedido (proposta) com a atitude na versão 1 e as origens (reporte ou veredicto,
 * por ID) numa transação. Não decide nada: o status nasce `novo` (view) e só humano muda isso.
 */
export class AgentesPedidoDepositarCapability {
  static readonly NAME = 'agentes.pedido.depositar';
  static readonly DESCRIPTION =
    'Deposit a request (pedido) with its attitude v1 (degrau, content, test case, target metric, window, rollback trigger) and its origins (report or verdict ids). Status starts as "novo".';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string): Promise<{ pedido_id: string; atitude_id: string }> {
    if (!principalName) throw new Error('agentes.pedido.depositar: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.repo.depositarPedido(principalName, input);
  }
}
