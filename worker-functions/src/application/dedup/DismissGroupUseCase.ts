/**
 * DismissGroupUseCase
 *
 * Marca um grupo de phone_normalized como "não é duplicado" persistentemente.
 * Usa a tabela dedup_dismissed (migration 226).
 * Idempotente: se já dispensado, retorna sem erro com alreadyDismissed=true.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import type { DismissGroupParams } from './DedupTypes';

const log = logger.child({ source: 'DismissGroupUseCase' });

export interface DismissResult {
  phoneNormalized: string;
  alreadyDismissed: boolean;
}

export class DismissGroupUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(params: DismissGroupParams): Promise<DismissResult> {
    const { phoneNormalized, reason, dismissedBy } = params;

    log.info({ msg: 'dismiss_group_start', phoneNormalized, dismissedBy });

    const res = await this.pool.query<{ id: number }>(
      `INSERT INTO dedup_dismissed (phone_normalized, reason, dismissed_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone_normalized) DO NOTHING
       RETURNING id`,
      [phoneNormalized, reason ?? null, dismissedBy ?? null],
    );

    const alreadyDismissed = res.rows.length === 0;

    log.info({
      msg: 'dismiss_group_done',
      phoneNormalized,
      alreadyDismissed,
    });

    return { phoneNormalized, alreadyDismissed };
  }
}
