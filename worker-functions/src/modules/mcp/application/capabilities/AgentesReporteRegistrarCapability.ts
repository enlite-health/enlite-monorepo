import { z } from 'zod';
import type { AgentesRepository } from '../../infrastructure/AgentesRepository';
import { AREA, AUTOR, OPERADOR, UUID, texto } from './agentesSchemas';

const ArgsShape = {
  autor: AUTOR,
  operador: OPERADOR,
  area: AREA,
  observacao: texto(500),
  regra_proposta: texto(300).optional(),
  veredicto_ids: z.array(UUID).max(100),
};

const ArgsSchema = z.object(ArgsShape).strict();

/**
 * AgentesReporteRegistrarCapability (agentes.reporte.registrar) — WRITE.
 *
 * A Maria registra o aviso de um gestor sobre um operador: campos curtos + a evidência POR ID
 * (`veredicto_ids`). Não há campo para trecho de conversa: payload com campo extra é recusado.
 */
export class AgentesReporteRegistrarCapability {
  static readonly NAME = 'agentes.reporte.registrar';
  static readonly DESCRIPTION =
    'Register a manager report about an operator: short fields (observacao <=500 chars) and evidence by verdict ids. No conversation excerpt is accepted.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string): Promise<{ id: string }> {
    if (!principalName) throw new Error('agentes.reporte.registrar: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.repo.registrarReporte(principalName, input);
  }
}
