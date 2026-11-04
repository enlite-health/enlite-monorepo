import { z } from 'zod';
import type { AgentesRepository, IndicadoresResult } from '../../infrastructure/AgentesRepository';
import { DATA_DIA } from './agentesSchemas';

const ArgsShape = {
  de: DATA_DIA,
  ate: DATA_DIA,
};

const ArgsSchema = z
  .object(ArgsShape)
  .strict()
  .refine((v) => v.de < v.ate, { message: 'de deve ser anterior a ate' });

/**
 * AgentesIndicadoresLerCapability (agentes.indicadores.ler) — READ (spec 078, item 41, linha de base).
 * Os números do painel de gestão (cadastros completos, vagas selecionadas) em [de, ate). Só contagens.
 */
export class AgentesIndicadoresLerCapability {
  static readonly NAME = 'agentes.indicadores.ler';
  static readonly DESCRIPTION =
    'Management-dashboard counts in [de, ate) (YYYY-MM-DD, de < ate): completed worker registrations (total and created in the window) and SELECTED job applications created in the window. Counts only, no ids, no text.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string): Promise<IndicadoresResult> {
    if (!principalName) throw new Error('agentes.indicadores.ler: principal ausente');
    const input = ArgsSchema.parse(args);
    return this.repo.lerIndicadores(principalName, input);
  }
}
