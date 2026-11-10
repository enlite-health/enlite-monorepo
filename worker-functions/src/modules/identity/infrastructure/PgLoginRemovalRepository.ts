/**
 * Adapter de `AccountLoginRemoval`: chama `iam.remove_login` (580/581), nunca escreve nas tabelas do `iam`.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { AccountLoginRemoval } from '../application/AccountLoginRemoval';

const PROVIDER = 'firebase';

export class PgLoginRemovalRepository implements AccountLoginRemoval {
  private pool?: Pool;

  constructor(pool?: Pool) {
    this.pool = pool;
  }

  async markDeleted(uid: string, actorUid: string): Promise<void> {
    const pool = (this.pool ??= DatabaseConnection.getInstance().getPool());
    await pool.query(`SELECT iam.remove_login($1, $2, $3)`, [PROVIDER, uid, actorUid]);
  }
}
