import { z } from 'zod';
import type { AgentesRepository } from '../../infrastructure/AgentesRepository';
import { AchadoSchema, ISO_DATA, OPERADOR, SENSORES, ref } from './agentesSchemas';

const ArgsShape = {
  operador: OPERADOR,
  sensor: z.enum(SENSORES),
  inbox: ref(1, 40),
  conversa_ref: ref(1, 80),
  ultima_msg_ref: ref(1, 80),
  nota: z.number().int().min(0).max(10).optional(),
  cruza_areas: z.boolean(),
  juiz_versao: ref(1, 40).optional(),
  avaliado_em: ISO_DATA,
  achados: z.array(AchadoSchema).max(100),
};

const ArgsSchema = z
  .object(ArgsShape)
  .strict()
  .refine((v) => (v.sensor === 'juiz') === (v.nota !== undefined), {
    message: 'nota só existe (e é obrigatória) quando o sensor é juiz',
  })
  .refine((v) => (v.sensor === 'juiz') === (v.juiz_versao !== undefined), {
    message: 'juiz_versao só existe (e é obrigatória) quando o sensor é juiz',
  });

/**
 * AgentesVeredictoRegistrarCapability (agentes.veredicto.registrar) — WRITE.
 *
 * O Sol grava o veredicto de UMA conversa avaliada + seus achados (violação/acerto por `regra_ref`),
 * numa transação. Sem texto de conversa: só referências. Duplicata (mesmo sensor/inbox/conversa/última
 * mensagem) devolve `{id, duplicado: true}` sem erro e sem regravar.
 */
export class AgentesVeredictoRegistrarCapability {
  static readonly NAME = 'agentes.veredicto.registrar';
  static readonly DESCRIPTION =
    'Register the verdict of one evaluated conversation plus its findings (rule refs, no conversation text). Idempotent: a duplicate returns {id, duplicado:true}.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string): Promise<{ id: string; duplicado?: true }> {
    if (!principalName) throw new Error('agentes.veredicto.registrar: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.repo.registrarVeredicto(principalName, input);
  }
}
