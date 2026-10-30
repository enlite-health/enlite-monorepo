import { z } from 'zod';
import type { AgentesRepository } from '../../infrastructure/AgentesRepository';
import { ISO_DATA, MOTIVOS_MEDICAO, UUID, ref } from './agentesSchemas';

const ArgsShape = {
  metrica: ref(1, 120),
  escopo: ref(1, 80),
  de: ISO_DATA,
  ate: ISO_DATA,
  valor: z.number().finite(),
  n: z.number().int().min(0),
  medido_em: ISO_DATA,
  motivo: z.enum(MOTIVOS_MEDICAO),
  pedido_id: UUID.optional(),
};

const ArgsSchema = z
  .object(ArgsShape)
  .strict()
  .refine((v) => Date.parse(v.de) <= Date.parse(v.ate), { message: 'de deve ser anterior ou igual a ate' })
  .refine((v) => (v.pedido_id === undefined) === (v.motivo === 'linha_de_base'), {
    message: 'linha_de_base não tem pedido_id; antes/depois exigem pedido_id',
  });

/**
 * AgentesMedicaoRegistrarCapability (agentes.medicao.registrar) — WRITE.
 *
 * A fila registra a FOTO datada de um número que muda (a linha de base, o antes e o depois de um pedido).
 * Só números e referências: métrica e escopo são slugs. O CHECK do banco (`medicoes_sem_pedido_so_linha_de_base`)
 * é a trava; a validação aqui é defesa em profundidade.
 */
export class AgentesMedicaoRegistrarCapability {
  static readonly NAME = 'agentes.medicao.registrar';
  static readonly DESCRIPTION =
    'Register a dated snapshot of a measured number (metric, scope, period, value, n, motive linha_de_base|antes|depois). Baseline has no pedido_id; before/after require it.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string): Promise<{ id: string }> {
    if (!principalName) throw new Error('agentes.medicao.registrar: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.repo.registrarMedicao(principalName, input);
  }
}
