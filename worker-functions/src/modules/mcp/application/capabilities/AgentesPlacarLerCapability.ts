import { z } from 'zod';
import type { AgentesRepository, PlacarResult } from '../../infrastructure/AgentesRepository';
import { ISO_DATA, OPERADOR } from './agentesSchemas';

const ArgsShape = {
  operador: OPERADOR,
  de: ISO_DATA,
  ate: ISO_DATA,
};

const ArgsSchema = z
  .object(ArgsShape)
  .strict()
  .refine((v) => Date.parse(v.de) < Date.parse(v.ate), { message: 'de deve ser anterior a ate' });

/** AgentesPlacarLerCapability (agentes.placar.ler) — READ. Agregados do operador em [de, ate). Sem nenhum texto. */
export class AgentesPlacarLerCapability {
  static readonly NAME = 'agentes.placar.ler';
  static readonly DESCRIPTION =
    'Scoreboard of one operator in [de, ate): violations per rule ref (count, max severity), average grade, conversation count, cross-area count and verdict ids. No text.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string): Promise<PlacarResult> {
    if (!principalName) throw new Error('agentes.placar.ler: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.repo.lerPlacar(principalName, input);
  }
}
