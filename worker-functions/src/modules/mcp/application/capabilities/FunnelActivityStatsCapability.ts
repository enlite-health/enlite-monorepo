/**
 * FunnelActivityStatsCapability
 *
 * Read capability de mensuração: quanto a Luz fez × quanto cada pessoa do time
 * fez no período (movimentos de funil, mudanças de status e edições de
 * cadastro), por ator. Contagens apenas — sem PII de candidato.
 *
 * Como a irmã `worker.profile.edits.stats`: é do principal de analytics/admin.
 * A Luz NÃO entra no allowlist — ela é medida, não mede.
 */

import { z } from 'zod';
import type {
  GetFunnelActivityStatsUseCase,
  FunnelActivityStatsResult,
} from '../../../matching/application/GetFunnelActivityStatsUseCase';

const ArgsShape = {
  /** Janela em dias (1–365). Default 30. */
  sinceDays: z.number().int().min(1).max(365).optional(),
};
const ArgsSchema = z.object(ArgsShape).strip();

export class FunnelActivityStatsCapability {
  static readonly NAME = 'funnel.activity.stats';
  static readonly DESCRIPTION =
    'Recruitment activity by actor over a period: funnel stage moves, worker status changes and ' +
    'profile edits, grouped by who did it (staff member, Luz, the worker, system routines). ' +
    'Rows recorded before instrumentation appear as "nao_instrumentado". Counts only — no candidate PII. ' +
    'Covers in-system actions only (team conversations on Periskope are not included). ' +
    'Args: sinceDays (default 30).';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: GetFunnelActivityStatsUseCase) {}

  async execute(args: unknown): Promise<FunnelActivityStatsResult> {
    const parsed = ArgsSchema.parse(args ?? {});
    return this.useCase.execute({ sinceDays: parsed.sinceDays ?? 30 });
  }
}
