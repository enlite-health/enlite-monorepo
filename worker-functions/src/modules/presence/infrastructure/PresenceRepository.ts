import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

/**
 * PresenceRepository — heartbeat de presença (change 022-ux-mencao-e-notificacao, Rodada 2,
 * reescrito 22/09/2026 para tabela própria `staff_presence`).
 *
 * Movido de `AdminRepository.touchPresence` para módulo PRÓPRIO (`@modules/presence`): presença é
 * reusável fora do `staff-directory` (identity) — o `staff-directory` só faz o LEFT JOIN de
 * LEITURA sobre `staff_presence` (`AdminRepository.searchStaffDirectory`), a ESCRITA vive aqui.
 *
 * UPSERT em vez de `UPDATE users` (versão anterior) — `INSERT ... ON CONFLICT DO UPDATE` na
 * própria tabela `staff_presence`, que NUNCA toca `users` — por isso o heartbeat nunca dispara o
 * trigger `update_users_updated_at` (`003_create_users_base_table.sql`), que regravaria
 * `users.updated_at` a cada ~60s por staff logado se a coluna estivesse em `users` (o defeito da
 * versão anterior deste desenho, corrigido nesta migration/reescrita).
 *
 * Throttle NO SQL (WHERE do `ON CONFLICT DO UPDATE`), não na aplicação: `now() - interval '30
 * seconds'` na própria cláusula torna a checagem e a escrita atômicas (sem round-trip de leitura
 * antes) — heartbeat chamado a cada ~60s do cliente já não bateria o throttle na maioria das
 * chamadas; a proteção é para chamada em rajada (retry, múltiplas abas em menos de 30s). Devolve
 * se REGRAVOU (para teste/observabilidade — o endpoint HTTP sempre responde 204 de qualquer forma,
 * throttle é transparente ao cliente).
 */
export class PresenceRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async touchPresence(firebaseUid: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO staff_presence (firebase_uid, last_seen_at)
       VALUES ($1, now())
       ON CONFLICT (firebase_uid) DO UPDATE
         SET last_seen_at = EXCLUDED.last_seen_at
       WHERE staff_presence.last_seen_at < now() - interval '30 seconds'`,
      [firebaseUid]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
