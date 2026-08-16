/**
 * src/modules/identity/permissions/infrastructure/PgRolloutStateRepository.ts
 *
 * Leitura do marcador de rollout (mig 282). Tabela ausente (ambiente que ainda
 * não aplicou a 282) devolve `null` em vez de explodir: quem chama é o alarme de
 * boot, e alarme que derruba o processo é o modo de falha que a lex C2 proíbe.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import type { RolloutStateRepository } from '../application/ports';

export class PgRolloutStateRepository implements RolloutStateRepository {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<string | null> {
    try {
      const result = await this.pool.query<{ value: string }>(
        `SELECT value FROM iam.rollout_state WHERE key = $1`,
        [key],
      );
      return result.rows[0]?.value ?? null;
    } catch (err) {
      logger.warn({ err, key }, '[perm] não foi possível ler iam.rollout_state — tratando como não marcado');
      return null;
    }
  }
}
