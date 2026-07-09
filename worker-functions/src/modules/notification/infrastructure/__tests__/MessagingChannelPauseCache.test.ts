/**
 * MessagingChannelPauseCache.test.ts
 *
 * Cenários:
 * 1. cache miss → consulta o banco e retorna o valor
 * 2. cache hit dentro do TTL → não consulta o banco de novo
 * 3. TTL expirado → consulta o banco novamente
 * 4. canal ausente na tabela → false (não pausado)
 * 5. invalidate(channel) força nova consulta apenas daquele canal
 * 6. invalidate() sem args limpa tudo
 */
import { MessagingChannelPauseCache } from '../MessagingChannelPauseCache';

describe('MessagingChannelPauseCache', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
  });

  it('cache miss: consulta o banco e retorna paused=true', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ paused: true }] });
    const cache = new MessagingChannelPauseCache(mockDb as any, 20000);

    const result = await cache.isPaused('periskope');

    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('messaging_channel_pause');
    expect(mockQuery.mock.calls[0][1]).toEqual(['periskope']);
  });

  it('cache hit dentro do TTL: não consulta o banco de novo', async () => {
    mockQuery.mockResolvedValue({ rows: [{ paused: false }] });
    const cache = new MessagingChannelPauseCache(mockDb as any, 20000);

    await cache.isPaused('periskope');
    const second = await cache.isPaused('periskope');

    expect(second).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('TTL expirado: consulta o banco novamente', async () => {
    jest.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [{ paused: false }] });
    const cache = new MessagingChannelPauseCache(mockDb as any, 1000);

    await cache.isPaused('periskope');
    jest.advanceTimersByTime(1001);
    await cache.isPaused('periskope');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('canal ausente na tabela: retorna false (não pausado)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const cache = new MessagingChannelPauseCache(mockDb as any, 20000);

    const result = await cache.isPaused('twilio');

    expect(result).toBe(false);
  });

  it('invalidate(channel) força nova consulta só daquele canal', async () => {
    mockQuery.mockResolvedValue({ rows: [{ paused: true }] });
    const cache = new MessagingChannelPauseCache(mockDb as any, 20000);

    await cache.isPaused('periskope');
    cache.invalidate('periskope');
    await cache.isPaused('periskope');

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('invalidate() sem args limpa todos os canais', async () => {
    mockQuery.mockResolvedValue({ rows: [{ paused: false }] });
    const cache = new MessagingChannelPauseCache(mockDb as any, 20000);

    await cache.isPaused('periskope');
    await cache.isPaused('twilio');
    cache.invalidate();
    await cache.isPaused('periskope');
    await cache.isPaused('twilio');

    expect(mockQuery).toHaveBeenCalledTimes(4);
  });
});
