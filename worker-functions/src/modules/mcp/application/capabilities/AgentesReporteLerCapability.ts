import { z } from 'zod';
import type { AgentesRepository } from '../../infrastructure/AgentesRepository';
import { ISO_DATA, OPERADOR } from './agentesSchemas';

const ArgsShape = {
  desde: ISO_DATA.optional(),
  operador: OPERADOR.optional(),
};

const ArgsSchema = z.object(ArgsShape).strict();

/** AgentesReporteLerCapability (agentes.reporte.ler) — READ. Reportes (campos curtos + ids), do mais novo, até 200. */
export class AgentesReporteLerCapability {
  static readonly NAME = 'agentes.reporte.ler';
  static readonly DESCRIPTION =
    'List manager reports (short fields + verdict ids), newest first, optionally since a date and/or for one operator. Max 200.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string) {
    if (!principalName) throw new Error('agentes.reporte.ler: principal ausente');
    const input = ArgsSchema.parse(args ?? {});
    return this.repo.lerReportes(principalName, input);
  }
}
