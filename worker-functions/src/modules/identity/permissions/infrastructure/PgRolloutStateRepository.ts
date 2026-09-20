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
 *
 * `set` (F12) é o outro lado — ESCRITA. A classe é a MESMA usada no boot
 * (`get`, via `app_runtime`/`app_system`) e no script de migração de dados
 * (`get` + `set`, via `pg.Pool` como owner) porque a ACL, não o código, decide
 * quem tem sucesso: a 282 revoga INSERT/UPDATE de `app_runtime`/`app_system` —
 * chamar `set` no caminho do processo estoura 42501 (o comportamento certo);
 * chamar como owner (o script) grava.
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

  /**
   * Upsert por `key`. Sem tratamento especial de erro: se a tabela não existe
   * (ambiente sem a 282) ou a role não tem grant (42501), o chamador (o
   * script) deve falhar alto — diferente de `get`, aqui não há "não sei"
   * aceitável, é um passo que o operador precisa ver falhar.
   */
  async set(key: string, value: string, note?: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO iam.rollout_state (key, value, note)
            VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note, updated_at = NOW()`,
      [key, value, note ?? null],
    );
  }
}
