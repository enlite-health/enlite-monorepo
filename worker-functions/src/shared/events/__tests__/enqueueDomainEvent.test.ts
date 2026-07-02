import { enqueueDomainEvent } from '../enqueueDomainEvent';
import type { PubSubClient } from '../PubSubClient';

function makePool(eventId = 'evt-abc') {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ id: eventId }] }),
  };
}

function makePubsub(publishImpl?: () => Promise<string | null>): jest.Mocked<Pick<PubSubClient, 'publish'>> {
  return {
    publish: jest.fn().mockImplementation(publishImpl ?? (() => Promise.resolve('msg-1'))),
  };
}

describe('enqueueDomainEvent', () => {
  afterEach(() => jest.clearAllMocks());

  it('inserts into domain_events and returns the eventId', async () => {
    const pool = makePool('evt-001');

    const eventId = await enqueueDomainEvent(pool as never, {
      event: 'worker.mirror_requested',
      payload: { workerId: 'w-1' },
      traceId: 'trace-x',
    });

    expect(eventId).toBe('evt-001');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO domain_events'),
      ['worker.mirror_requested', JSON.stringify({ workerId: 'w-1' }), 'trace-x'],
    );
  });

  it('calls pubsub.publish with eventId when pubsub + topic provided', async () => {
    const pool = makePool('evt-002');
    const pubsub = makePubsub();

    await enqueueDomainEvent(pool as never, {
      event: 'worker.mirror_requested',
      payload: { workerId: 'w-2' },
      pubsub: pubsub as unknown as PubSubClient,
      topic: 'worker-mirror-requested',
    });

    expect(pubsub.publish).toHaveBeenCalledWith('worker-mirror-requested', { eventId: 'evt-002' });
  });

  it('does NOT call publish when pubsub is omitted', async () => {
    const pool = makePool('evt-003');
    const pubsub = makePubsub();

    await enqueueDomainEvent(pool as never, {
      event: 'worker.mirror_requested',
      payload: { workerId: 'w-3' },
      // pubsub intentionally omitted
    });

    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('does NOT call publish when topic is omitted', async () => {
    const pool = makePool('evt-004');
    const pubsub = makePubsub();

    await enqueueDomainEvent(pool as never, {
      event: 'worker.mirror_requested',
      payload: { workerId: 'w-4' },
      pubsub: pubsub as unknown as PubSubClient,
      // topic intentionally omitted
    });

    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('swallows publish errors (best-effort) and does NOT rethrow', async () => {
    const pool = makePool('evt-005');
    const pubsub = makePubsub(() => Promise.reject(new Error('UNAVAILABLE')));

    await expect(
      enqueueDomainEvent(pool as never, {
        event: 'worker.mirror_requested',
        payload: { workerId: 'w-5' },
        pubsub: pubsub as unknown as PubSubClient,
        topic: 'worker-mirror-requested',
      }),
    ).resolves.toBe('evt-005');

    expect(pubsub.publish).toHaveBeenCalled();
  });

  it('rethrows INSERT errors (not best-effort)', async () => {
    const pool = {
      query: jest.fn().mockRejectedValue(new Error('DB_DOWN')),
    };

    await expect(
      enqueueDomainEvent(pool as never, {
        event: 'worker.mirror_requested',
        payload: { workerId: 'w-6' },
      }),
    ).rejects.toThrow('DB_DOWN');
  });

  it('uses null traceId when not provided', async () => {
    const pool = makePool('evt-007');

    await enqueueDomainEvent(pool as never, {
      event: 'worker.mirror_requested',
      payload: { workerId: 'w-7' },
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.any(String),
      ['worker.mirror_requested', expect.any(String), null],
    );
  });
});
