import { z } from 'zod';
import type { AgentesRepository } from '../../infrastructure/AgentesRepository';
import { AREA, AUTOR, CASOS_REPORTE, DATA_DIA, OPERADOR, UUID, ref, texto } from './agentesSchemas';

const ArgsShape = {
  autor: AUTOR,
  operador: OPERADOR,
  area: AREA,
  caso: z.enum(CASOS_REPORTE),
  regra_ref: ref(1, 200).optional(),
  ocorrencias: z.number().int().min(0).max(32767).optional(),
  janela_de: DATA_DIA,
  janela_ate: DATA_DIA,
  observacao: texto(500),
  regra_proposta: texto(300).optional(),
  veredicto_ids: z.array(UUID).max(100),
};

const ArgsSchema = z
  .object(ArgsShape)
  .strict()
  .refine((v) => v.caso === 'meta' || v.regra_ref !== undefined, { message: 'regra_ref só pode faltar no caso meta' })
  .refine((v) => v.janela_ate >= v.janela_de, { message: 'janela_ate deve ser >= janela_de' });

/**
 * AgentesReporteRegistrarCapability (agentes.reporte.registrar) — WRITE.
 *
 * A Maria registra o aviso sobre um operador: caso (leve|meta|reforco), regra, ocorrências e janela
 * como campos TIPADOS + `observacao` curta + a evidência POR ID (`veredicto_ids`). Não há campo para trecho de
 * conversa: payload com campo extra é recusado. Duplicata (operador, caso, regra_ref, janela) devolve
 * `{id, duplicado: true}` sem regravar (a Maria roda todo dia).
 */
export class AgentesReporteRegistrarCapability {
  static readonly NAME = 'agentes.reporte.registrar';
  static readonly DESCRIPTION =
    'Register a report about an operator: typed fields (caso leve|meta|reforco, regra_ref, ocorrencias, janela_de/janela_ate), short observacao (<=500 chars) and evidence by verdict ids. Idempotent: a duplicate returns {id, duplicado:true}. No conversation excerpt is accepted.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string): Promise<{ id: string; duplicado?: true }> {
    if (!principalName) throw new Error('agentes.reporte.registrar: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.repo.registrarReporte(principalName, input);
  }
}
