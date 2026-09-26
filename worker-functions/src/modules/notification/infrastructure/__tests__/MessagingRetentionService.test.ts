import { MessagingRetentionService } from '../MessagingRetentionService';

describe('MessagingRetentionService', () => {
  function mockPool(tokensDeleted: number, outboxDeleted: number, bulkDeleted: number) {
    const query = jest
      .fn()
      .mockImplementationOnce(async (sql: string) => {
        expect(sql).toContain('cleanup_expired_tokens()');
        return { rows: [{ cleanup_expired_tokens: String(tokensDeleted) }] };
      })
      .mockImplementationOnce(async (sql: string) => {
        expect(sql).toContain('archive_old_messages()');
        return { rows: [{ outbox_deleted: String(outboxDeleted), bulk_deleted: String(bulkDeleted) }] };
      });
    return { query } as unknown as import('pg').Pool;
  }

  it('runs cleanup_expired_tokens() before archive_old_messages() and returns both counts', async () => {
    const pool = mockPool(1501, 226, 40);
    const service = new MessagingRetentionService(pool);

    const result = await service.run();

    expect(result).toEqual({ outboxDeleted: 226, bulkDeleted: 40, tokensDeleted: 1501 });
    // Prova de ORDEM: cleanup_expired_tokens() é a 1ª chamada, archive_old_messages() a 2ª —
    // tokens de PII (TTL 24h) não esperam o ciclo de archiving (90/365 dias).
    expect((pool.query as jest.Mock).mock.calls[0][0]).toContain('cleanup_expired_tokens()');
    expect((pool.query as jest.Mock).mock.calls[1][0]).toContain('archive_old_messages()');
  });

  it('returns zero counts when nothing is expired', async () => {
    const pool = mockPool(0, 0, 0);
    const service = new MessagingRetentionService(pool);

    const result = await service.run();

    expect(result).toEqual({ outboxDeleted: 0, bulkDeleted: 0, tokensDeleted: 0 });
  });
});
