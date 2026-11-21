/**
 * GetWorkerItineraryUseCase — `GET /api/workers/me/itinerary` (spec 077 F1, bloco 1.4).
 *
 * Identidade SÓ pelo `uid` do token. Resolve `workers.id`/`status` por `auth_uid` dentro de `withActorContext` (nunca
 * conexão crua do pool: RLS derruba com 500). Conta ABSORVIDA numa união (`merged_into_id`) segue a corrente por
 * `resolveCanonicalWorkerId` — o mesmo caminho de `findByAuthUid` (C-47/FR-91): o login antigo cai no itinerário do
 * sobrevivente, e o `status` que vale é o dele. Corrente irresolvível (ciclo) → mantém a linha do uid (fail-open, como
 * `findByAuthUid`; o resolver loga o warn). Worker inexistente OU `status = 'DISABLED'` (CHECK da migration 096:
 * REGISTERED | INCOMPLETE_REGISTER | DISABLED) → `AccountInactiveError` (403 ACCOUNT_INACTIVE).
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { resolveCanonicalWorkerId } from '@shared/database/resolveCanonicalWorkerId';
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
      const found = await client.query<{ id: string; status: string; merged_into_id: string | null }>(
        'SELECT id, status, merged_into_id FROM workers WHERE auth_uid = $1 LIMIT 1',
        [args.uid],
      );
      let row: { id: string; status: string } | undefined = found.rows[0];
      if (row && found.rows[0].merged_into_id != null) {
        const canonicalId = await resolveCanonicalWorkerId(client, row.id);
        if (canonicalId != null && canonicalId !== row.id) {
          const canonical = await client.query<{ status: string }>('SELECT status FROM workers WHERE id = $1::uuid', [canonicalId]);
          row = canonical.rows[0] ? { id: canonicalId, status: canonical.rows[0].status } : row;
        }
      }
      if (!row || row.status === 'DISABLED') throw new AccountInactiveError();
      return readWorkerWindow(client, { workerId: row.id, today: args.today });
    });
  }
}
