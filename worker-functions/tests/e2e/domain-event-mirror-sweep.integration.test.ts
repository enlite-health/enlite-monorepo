/**
 * domain-event-mirror-sweep.integration.test.ts
 *
 * Teste de integração com banco REAL para o sweep escopado de
 * `worker.mirror_requested`:
 *   - DomainEventProcessor.sweepPendingByEvent(eventName, ...)
 *   - DomainEventProcessor.deleteRedundantMirrorEvents()
 *
 * Não usa mock de banco — insere/lê/apaga direto no Postgres do docker
 * (enlite_e2e), espelhando o padrão de domain-event-backlog.integration.test.ts.
 */

import { Pool } from 'pg';
import { DomainEventProcessor } from '../../src/shared/events/DomainEventProcessor';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OTHER_EVENT = `e2e.mirror-sweep.other.${SUFFIX}`;

const createdWorkerIds: string[] = [];
const createdEventIds: string[] = [];

async function insertWorker(overrides: { syncedAt?: Date | null } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO workers (auth_uid, email, phone, status, country,
       first_name_encrypted, last_name_encrypted, sex_encrypted, ana_care_synced_at)
     VALUES ($1, $2, $3, 'REGISTERED', 'AR', 'enc-fn', 'enc-ln', 'enc-sex', $4)
     RETURNING id`,
    [
      `e2e-mirror-sweep-${SUFFIX}-${createdWorkerIds.length}`,
      `e2e-mirror-sweep-${SUFFIX}-${createdWorkerIds.length}@example.com`,
      null,
      overrides.syncedAt ? overrides.syncedAt.toISOString() : null,
    ],
  );
  const id = rows[0].id as string;
  createdWorkerIds.push(id);
  return id;
}

async function insertMirrorEvent(workerId: string, createdAt: Date, status = 'pending'): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO domain_events (event, payload, status, created_at)
     VALUES ('worker.mirror_requested', $1, $2, $3)
     RETURNING id`,
    [JSON.stringify({ workerId }), status, createdAt.toISOString()],
  );
  const id = rows[0].id as string;
  createdEventIds.push(id);
  return id;
}

async function insertOtherEvent(createdAt: Date): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO domain_events (event, payload, status, created_at)
     VALUES ($1, '{}'::jsonb, 'pending', $2)
     RETURNING id`,
    [OTHER_EVENT, createdAt.toISOString()],
  );
  const id = rows[0].id as string;
  createdEventIds.push(id);
  return id;
}

async function eventExists(id: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM domain_events WHERE id = $1`, [id]);
  return rows.length > 0;
}

afterAll(async () => {
  await pool.query('DELETE FROM domain_events WHERE id = ANY($1::uuid[])', [createdEventIds]);
  await pool.query('DELETE FROM workers WHERE id = ANY($1::uuid[])', [createdWorkerIds]);
  await pool.end();
});

describe('DomainEventProcessor.deleteRedundantMirrorEvents (banco real)', () => {
  it('deletes a pending event for a worker already synced (ana_care_synced_at set)', async () => {
    const processor = new DomainEventProcessor(pool);
    const workerId = await insertWorker({ syncedAt: new Date() });
    const eventId = await insertMirrorEvent(workerId, new Date(Date.now() - 40 * 60_000));

    const deleted = await processor.deleteRedundantMirrorEvents();

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await eventExists(eventId)).toBe(false);
  });

  it('dedup: deletes the older pending event and KEEPS the newer one for the same worker', async () => {
    const processor = new DomainEventProcessor(pool);
    const workerId = await insertWorker({ syncedAt: null });
    const olderId = await insertMirrorEvent(workerId, new Date(Date.now() - 60 * 60_000));
    const newerId = await insertMirrorEvent(workerId, new Date(Date.now() - 35 * 60_000));

    await processor.deleteRedundantMirrorEvents();

    expect(await eventExists(olderId)).toBe(false);
    expect(await eventExists(newerId)).toBe(true);
  });

  it('does NOT delete the only pending event of a not-yet-synced worker', async () => {
    const processor = new DomainEventProcessor(pool);
    const workerId = await insertWorker({ syncedAt: null });
    const eventId = await insertMirrorEvent(workerId, new Date(Date.now() - 45 * 60_000));

    await processor.deleteRedundantMirrorEvents();

    expect(await eventExists(eventId)).toBe(true);
  });

  it('does NOT delete an event younger than the 30min in-flight guard', async () => {
    const processor = new DomainEventProcessor(pool);
    const workerId = await insertWorker({ syncedAt: new Date() });
    // 5 minutes old — inside the anti in-flight guard, even though synced.
    const eventId = await insertMirrorEvent(workerId, new Date(Date.now() - 5 * 60_000));

    await processor.deleteRedundantMirrorEvents();

    expect(await eventExists(eventId)).toBe(true);
  });
});

describe('DomainEventProcessor.sweepPendingByEvent (banco real)', () => {
  it('only processes events matching the given event name; other pending types stay untouched', async () => {
    const processor = new DomainEventProcessor(pool);
    const handler = jest.fn().mockResolvedValue(undefined);
    processor.registerHandler('worker.mirror_requested', handler);

    const workerId = await insertWorker({ syncedAt: null });
    const mirrorEventId = await insertMirrorEvent(workerId, new Date(Date.now() - 10 * 60_000));
    const otherEventId = await insertOtherEvent(new Date(Date.now() - 10 * 60_000));

    const result = await processor.sweepPendingByEvent('worker.mirror_requested', 5, 100);

    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.processed).toBeGreaterThanOrEqual(1);
    // O `meta` carrega o id da PROPRIA linha varrida (D187) — asserir o valor real,
    // e nao `expect.anything()`, faz este teste vigiar o contrato novo do processor.
    expect(handler).toHaveBeenCalledWith({ workerId }, { eventId: mirrorEventId });

    // The other event type must remain pending — untouched by this sweep.
    const { rows } = await pool.query(`SELECT status FROM domain_events WHERE id = $1`, [otherEventId]);
    expect(rows[0].status).toBe('pending');

    // Sanity: the mirror event itself is now processed.
    const { rows: mirrorRows } = await pool.query(`SELECT status FROM domain_events WHERE id = $1`, [
      mirrorEventId,
    ]);
    expect(mirrorRows[0].status).toBe('processed');
  });
});
