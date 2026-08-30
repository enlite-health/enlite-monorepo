import { DomainEventProcessor } from '../DomainEventProcessor';

describe('DomainEventProcessor', () => {
  let mockQuery: jest.Mock;
  let mockConnect: jest.Mock;
  let mockRelease: jest.Mock;
  let mockPool: any;
  let processor: DomainEventProcessor;

  beforeEach(() => {
    mockQuery = jest.fn();
    mockRelease = jest.fn();
    mockConnect = jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockPool = { connect: mockConnect, query: jest.fn() };
    processor = new DomainEventProcessor(mockPool);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('dispatches to the correct registered handler', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    processor.registerHandler('worker.qualified', handler);

    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'evt-1', event: 'worker.qualified', payload: { workerId: 'w-1' }, status: 'pending' }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const result = await processor.processEvent('evt-1');

    expect(result.status).toBe('processed');
    // O id da LINHA vai como meta (2º argumento) — o payload não o carrega (A1 do gate 30/08).
    expect(handler).toHaveBeenCalledWith({ workerId: 'w-1' }, { eventId: 'evt-1' });
  });

  it('returns skipped when event is not found in DB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await processor.processEvent('evt-nonexistent');
    expect(result.status).toBe('skipped');
  });

  it('skips already-processed events (idempotent)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'evt-1', event: 'worker.qualified', payload: {}, status: 'processed' }],
    });

    const result = await processor.processEvent('evt-1');
    expect(result.status).toBe('skipped');
  });

  it('marks event as failed when no handler is registered', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'evt-1', event: 'unknown.event', payload: {}, status: 'pending' }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE failed

    const result = await processor.processEvent('evt-1');

    expect(result.status).toBe('failed');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE domain_events SET status'),
      expect.arrayContaining(['evt-1', expect.stringContaining('No handler')]),
    );
  });

  it('marks event as failed when handler throws', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('boom'));
    processor.registerHandler('worker.qualified', handler);

    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'evt-1', event: 'worker.qualified', payload: {}, status: 'pending' }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE failed

    const result = await processor.processEvent('evt-1');

    expect(result.status).toBe('failed');
    expect(handler).toHaveBeenCalled();
  });

  describe('sweepPendingEvents', () => {
    it('reprocesses orphan pending events', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      processor.registerHandler('worker.qualified', handler);

      // sweep query returns orphan events
      mockPool.query = jest.fn().mockResolvedValue({
        rows: [{ id: 'evt-orphan-1' }],
      });

      // processEvent calls
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'evt-orphan-1', event: 'worker.qualified', payload: {}, status: 'pending' }],
        })
        .mockResolvedValueOnce({ rows: [] }); // UPDATE processed

      const count = await processor.sweepPendingEvents(5, 10);
      expect(count).toBe(1);
      expect(handler).toHaveBeenCalled();
    });
  });
});
