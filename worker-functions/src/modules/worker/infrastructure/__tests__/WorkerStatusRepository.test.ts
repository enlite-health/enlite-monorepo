/**
 * Unit tests for WorkerStatusRepository.
 *
 * Covers:
 *  - recalculateWorkerStatus: when status becomes REGISTERED, the status UPDATE
 *    and domain_events INSERT are in the same transaction (BEGIN/COMMIT).
 *  - recalculateWorkerStatus: after commit, publishes to Pub/Sub best-effort.
 *  - recalculateWorkerStatus: publish failure does NOT propagate.
 *  - recalculateWorkerStatus: non-REGISTERED transitions use plain updateWorkerStatus
 *    (no domain_events INSERT, no Pub/Sub call).
 *  - updateWorkerStatus: wraps UPDATE in BEGIN/COMMIT.
 *
 * Strategy: mock Pool + PoolClient; mock WorkerImportRepository._recalculateStatus
 * to control what status is returned and call the updateStatusFn we pass.
 */

jest.mock('../WorkerImportRepository', () => ({
  recalculateStatus: jest.fn(),
}));

import { recalculateWorkerStatus, updateWorkerStatus } from '../WorkerStatusRepository';
import { recalculateStatus as mockRecalculate } from '../WorkerImportRepository';
import type { PubSubClient } from '@shared/events/PubSubClient';

const mockedRecalculate = mockRecalculate as jest.MockedFunction<typeof mockRecalculate>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
}

function makePool(client = makeClient()) {
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    _client: client,
  };
}

function makePubsub(): jest.Mocked<Pick<PubSubClient, 'publish'>> {
  return { publish: jest.fn().mockResolvedValue('msg-1') };
}

// Make recalculateStatus call the callback with the given status and return it.
function setupRecalculate(status: string) {
  mockedRecalculate.mockImplementation(async (_pool, _workerId, updateFn) => {
    await updateFn(_workerId, status as never);
    return status as never;
  });
}

// Make recalculateStatus return null (status unchanged).
function setupRecalculateNoChange() {
  mockedRecalculate.mockResolvedValue(null);
}

afterEach(() => jest.clearAllMocks());

// ── updateWorkerStatus ─────────────────────────────────────────────────────────

describe('updateWorkerStatus', () => {
  it('runs BEGIN, UPDATE, COMMIT in that order', async () => {
    const client = makeClient();
    const pool = makePool(client);

    await updateWorkerStatus(pool as never, 'w-1', 'INCOMPLETE_REGISTER');

    const calls = client.query.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toMatch(/UPDATE workers SET status/);
    expect(calls[2]).toBe('COMMIT');
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it('rolls back and rethrows on error', async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('DB_ERR')); // UPDATE
    const pool = makePool(client);

    await expect(updateWorkerStatus(pool as never, 'w-1', 'INCOMPLETE_REGISTER')).rejects.toThrow('DB_ERR');

    const calls = client.query.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain('ROLLBACK');
  });
});

// ── recalculateWorkerStatus ────────────────────────────────────────────────────

describe('recalculateWorkerStatus', () => {
  it('runs status UPDATE + domain_events INSERT atomically when REGISTERED', async () => {
    setupRecalculate('REGISTERED');
    const client = makeClient();
    // Simulate INSERT RETURNING id for the domain_events row
    client.query
      .mockResolvedValueOnce({ rows: [] })                        // BEGIN
      .mockResolvedValueOnce({ rows: [] })                        // UPDATE workers
      .mockResolvedValueOnce({ rows: [{ id: 'evt-reg-1' }] })    // INSERT domain_events
      .mockResolvedValueOnce({ rows: [] });                       // COMMIT
    const pool = makePool(client);

    const result = await recalculateWorkerStatus(pool as never, 'w-reg', null);

    expect(result).toBe('REGISTERED');
    const calls = client.query.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toMatch(/UPDATE workers SET status/);
    expect(calls[2]).toMatch(/INSERT INTO domain_events/);
    expect(calls[3]).toBe('COMMIT');
  });

  it('publishes to worker-mirror-requested after REGISTERED transition', async () => {
    setupRecalculate('REGISTERED');
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'evt-pub-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = makePool(client);
    const pubsub = makePubsub();

    await recalculateWorkerStatus(pool as never, 'w-pub', pubsub as unknown as PubSubClient);

    expect(pubsub.publish).toHaveBeenCalledWith('worker-mirror-requested', { eventId: 'evt-pub-1' });
  });

  it('does NOT publish when pubsub is null', async () => {
    setupRecalculate('REGISTERED');
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'evt-nopub' }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = makePool(client);

    // Should not throw, and no publish.
    const result = await recalculateWorkerStatus(pool as never, 'w-nopub', null);
    expect(result).toBe('REGISTERED');
  });

  it('swallows publish error (best-effort) after REGISTERED', async () => {
    setupRecalculate('REGISTERED');
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'evt-swallow' }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = makePool(client);
    const pubsub = makePubsub();
    pubsub.publish.mockRejectedValue(new Error('UNAVAILABLE'));

    await expect(
      recalculateWorkerStatus(pool as never, 'w-swallow', pubsub as unknown as PubSubClient),
    ).resolves.toBe('REGISTERED');
  });

  it('does NOT insert domain_events or publish for non-REGISTERED transitions', async () => {
    setupRecalculate('INCOMPLETE_REGISTER');
    const client = makeClient();
    const pool = makePool(client);
    const pubsub = makePubsub();

    await recalculateWorkerStatus(pool as never, 'w-incomplete', pubsub as unknown as PubSubClient);

    // Pool.connect is used by updateWorkerStatus (non-REGISTERED branch)
    const insertCalls = client.query.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => sql.includes('domain_events'));
    expect(insertCalls).toHaveLength(0);
    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('returns null and does nothing when status is unchanged', async () => {
    setupRecalculateNoChange();
    const client = makeClient();
    const pool = makePool(client);
    const pubsub = makePubsub();

    const result = await recalculateWorkerStatus(pool as never, 'w-same', pubsub as unknown as PubSubClient);

    expect(result).toBeNull();
    expect(pubsub.publish).not.toHaveBeenCalled();
  });
});
