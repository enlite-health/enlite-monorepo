import { z } from 'zod';
import type { AgentesRepository, PlacarResult } from '../../infrastructure/AgentesRepository';
import { ISO_DATA, OPERADOR, ref } from './agentesSchemas';

const ArgsShape = {
  operador: OPERADOR,
  de: ISO_DATA,
  ate: ISO_DATA,
  /** regra_ref das regras NUNCA (lista fechada do GRAVE, item 53): violação delas vira grave `nunca`. Opcional. */
  nunca_refs: z.array(ref(3, 120)).max(200).optional(),
};

const ArgsSchema = z
  .object(ArgsShape)
  .strict()
  .refine((v) => Date.parse(v.de) < Date.parse(v.ate), { message: 'de deve ser anterior a ate' });

/** AgentesPlacarLerCapability (agentes.placar.ler) — READ. Agregados do operador em [de, ate). Sem nenhum texto. */
export class AgentesPlacarLerCapability {
  static readonly NAME = 'agentes.placar.ler';
  static readonly DESCRIPTION =
    'Scoreboard of one operator in [de, ate): violations per rule ref (count, max severity), average grade, conversation count, cross-area count and verdict ids; plus `graves` (closed list of 3 triggers: scrubber finding = dado, notario finding = acao_fabricada, rule ref in optional nunca_refs = nunca; judge severity alone never counts). No text.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string): Promise<PlacarResult> {
    if (!principalName) throw new Error('agentes.placar.ler: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.repo.lerPlacar(principalName, input);
  }
}
