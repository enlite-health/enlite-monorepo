/**
 * PgCoordinationAlertStore contra POSTGRES REAL (migration 597, emenda 077 §5.3): a idempotência por turno (UNIQUE + ON CONFLICT) e a
 * reivindicação atômica da entrega de e-mail.
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5461/enlite_e2e npx jest --config jest.config.repo.js CoordinationAlertStore --maxWorkers=2
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { PgCoordinationAlertStore } from '../../src/modules/case/infrastructure/PgCoordinationAlertStore';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5461/enlite_e2e';

describe('PgCoordinationAlertStore (Postgres real)', () => {
  let pool: Pool;
  let store: PgCoordinationAlertStore;
  const occurrences: string[] = [];
  const newOccurrence = (): string => { const o = randomUUID(); occurrences.push(o); return o; };

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    store = new PgCoordinationAlertStore(pool);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM coordination_alert_delivery WHERE alert_id IN (SELECT alert_id FROM coordination_alert WHERE occurrence_id = ANY($1::uuid[]))`, [occurrences]);
    await pool.query(`DELETE FROM coordination_alert WHERE occurrence_id = ANY($1::uuid[])`, [occurrences]);
    await pool.end();
  });

  it('2ª execução para o MESMO turno e a MESMA regra → insertAlertIfAbsent devolve null e o banco continua com 1 linha', async () => {
    const occ = newOccurrence();
    const first = await store.inTransaction((tx) => tx.insertAlertIfAbsent('PRESENCE_OPEN_4H', occ));
    const second = await store.inTransaction((tx) => tx.insertAlertIfAbsent('PRESENCE_OPEN_4H', occ));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(Number((await pool.query(`SELECT count(*) AS n FROM coordination_alert WHERE occurrence_id = $1`, [occ])).rows[0].n)).toBe(1);
    // outra regra para o mesmo turno é OUTRO alerta
    expect(await store.inTransaction((tx) => tx.insertAlertIfAbsent('CHECK_IN_REFUSED_NO_ENTRY', occ))).not.toBeNull();
  });

  it('entrega: PENDING → claim (1 só vence) → mark; o resultado fica no banco; transação com erro desfaz o alerta', async () => {
    const occ = newOccurrence();
    const alertId = (await store.inTransaction(async (tx) => {
      const id = (await tx.insertAlertIfAbsent('PRESENCE_OPEN_4H', occ)) as string;
      await tx.recordDelivery({ alertId: id, recipientUid: 'uid-1', channel: 'EMAIL', status: 'PENDING' });
      return id;
    }));
    const claims = await Promise.all([store.claimDelivery(alertId, 'uid-1', 'EMAIL'), store.claimDelivery(alertId, 'uid-1', 'EMAIL')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.markDelivery(alertId, 'uid-1', 'EMAIL', { status: 'FAILED', errorCode: 'EMAIL_ERROR' });
    expect((await pool.query(`SELECT status, error_code FROM coordination_alert_delivery WHERE alert_id = $1`, [alertId])).rows[0]).toEqual({ status: 'FAILED', error_code: 'EMAIL_ERROR' });

    const occ2 = newOccurrence();
    await expect(store.inTransaction(async (tx) => { await tx.insertAlertIfAbsent('PRESENCE_OPEN_4H', occ2); throw new Error('falha do in-app'); })).rejects.toThrow('falha do in-app');
    expect(Number((await pool.query(`SELECT count(*) AS n FROM coordination_alert WHERE occurrence_id = $1`, [occ2])).rows[0].n)).toBe(0);
  });
});
