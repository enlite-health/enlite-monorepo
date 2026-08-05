/**
 * WorkerProfileEditsStatsCapability
 *
 * Read capability de mensuração: distribuição de edições de campo de perfil
 * por fonte (luz_conversation | worker_self | admin_panel | sync_import) no
 * período. Pensada pro principal de analytics/admin — NÃO entra no allowlist
 * da Luz (ela escreve a trilha, não mede).
 */

import { z } from 'zod';
import type {
  GetProfileEditsStatsUseCase,
  ProfileEditsStatsResult,
} from '../../../worker/application/GetProfileEditsStatsUseCase';

const ArgsShape = {
  /** Janela em dias (1–365). Default 30. */
  sinceDays: z.number().int().min(1).max(365).optional(),
};
const ArgsSchema = z.object(ArgsShape).strip();

export class WorkerProfileEditsStatsCapability {
  static readonly NAME = 'worker.profile.edits.stats';
  static readonly DESCRIPTION =
    'Distribution of worker profile field edits by source (luz_conversation, worker_self, ' +
    'admin_panel, sync_import) over a period. Counts only — no PII. ' +
    'Args: sinceDays (default 30).';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: GetProfileEditsStatsUseCase) {}

  async execute(args: unknown): Promise<ProfileEditsStatsResult> {
    const parsed = ArgsSchema.parse(args ?? {});
    return this.useCase.execute({ sinceDays: parsed.sinceDays ?? 30 });
  }
}
