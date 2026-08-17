/**
 * src/modules/identity/permissions/infrastructure/PgRolloutStateRepository.ts
 *
 * Leitura do marcador de rollout (mig 282).
 *
 * ⚠️ A distinção aqui decide se o processo sobe. Existem DOIS "não achei", e
 * tratá-los igual foi um bug real (achado na 2ª rodada do gate do grupo 3):
 *
 *   · **tabela ausente** (`42P01`) — ambiente que ainda não aplicou a 282. É
 *     legítimo e significa "não marcado": devolve `null`, e quem chama decide.
 *   · **qualquer outro erro** (conexão derrubada, statement timeout) — NÃO
 *     significa "não marcado": significa "não sei". Antes isto virava `null`, e
 *     o gate de boot lia como "a migração não rodou" e MATAVA o processo — com
 *     o engine ligado, uma oscilação de conexão tirava do ar a app do
 *     prestador, os leads e os webhooks. Agora relança, e quem chama trata
 *     "não sei" pelo que é.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import type { RolloutStateRepository } from '../application/ports';

/** `undefined_table` — o único erro que significa mesmo "ainda não marcado". */
const UNDEFINED_TABLE = '42P01';

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
      if ((err as { code?: string })?.code === UNDEFINED_TABLE) {
        logger.warn({ key }, '[perm] iam.rollout_state ainda não existe neste ambiente — tratando como não marcado');
        return null;
      }
      throw err;
    }
  }
}
