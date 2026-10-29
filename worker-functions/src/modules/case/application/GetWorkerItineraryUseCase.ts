/**
 * GetWorkerItineraryUseCase — `GET /api/workers/me/itinerary` (spec 077 F1, bloco 1.4).
 *
 * Identidade SÓ pelo `uid` do token. Resolve `workers.id`/`status` por `auth_uid` dentro de `withActorContext` (nunca
 * conexão crua do pool: RLS derruba com 500). Worker inexistente OU `status = 'DISABLED'` (CHECK da migration 096:
 * REGISTERED | INCOMPLETE_REGISTER | DISABLED) → `AccountInactiveError` (403 ACCOUNT_INACTIVE).
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { readWorkerWindow, type ItineraryEnvelope } from '../infrastructure/WorkerItineraryReader';

export class AccountInactiveError extends Error {
  readonly code = 'ACCOUNT_INACTIVE';
  constructor() {
    super('account inactive');
    this.name = 'AccountInactiveError';
  }
}

export class GetWorkerItineraryUseCase {
  private poolMemo?: Pool;

  constructor(pool?: Pool) {
    this.poolMemo = pool;
  }

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async execute(args: { uid: string; today: string }): Promise<ItineraryEnvelope> {
    return withActorContext(this.pool, async (client) => {
      const found = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM workers WHERE auth_uid = $1 LIMIT 1',
        [args.uid],
      );
      const row = found.rows[0];
      if (!row || row.status === 'DISABLED') throw new AccountInactiveError();
      return readWorkerWindow(client, { workerId: row.id, today: args.today });
    });
  }
}
