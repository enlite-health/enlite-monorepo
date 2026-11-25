import { MessagingRetentionService } from '../MessagingRetentionService';

type InboxRow = { state: string; processedAgeDays: number | null; receivedAgeDays: number; payload: string | null };

/**
 * Pool falso: as 2 funções do banco respondem fixo; as queries da inbox são AVALIADAS sobre linhas em
 * memória a partir do predicado que está no SQL (filtro de state, intervalo em dias, IS NOT NULL).
 * Tirar o filtro de state do UPDATE muda o resultado e reprova.
 */
function fakePool(rows: InboxRow[]) {
  const query = jest.fn(async (sql: string) => {
    const q = sql.replace(/\s+/g, ' ');
    if (q.includes('cleanup_expired_tokens()')) return { rows: [{ cleanup_expired_tokens: '1501' }] };
    if (q.includes('archive_old_messages()')) return { rows: [{ outbox_deleted: '226', bulk_deleted: '40' }] };
    const days = Number(/interval '(\d+) days'/.exec(q)?.[1]);
    if (q.startsWith('UPDATE talentum_webhook_inbox SET payload_enc = NULL')) {
      const onlyProcessed = q.includes("state = 'PROCESSED'");
      let n = 0;
      for (const r of rows) {
        if (onlyProcessed && r.state !== 'PROCESSED') continue;
        if (r.processedAgeDays === null || !(r.processedAgeDays > days)) continue;
        if (r.payload === null) continue;
        r.payload = null;
        n++;
      }
      return { rows: [], rowCount: n };
    }
    if (q.startsWith('DELETE FROM talentum_webhook_inbox')) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].receivedAgeDays > days) rows.splice(i, 1);
      return { rows: [], rowCount: before - rows.length };
    }
    throw new Error(`SQL inesperado: ${q}`);
  });
  return { query } as unknown as import('pg').Pool & { query: jest.Mock };
}

describe('MessagingRetentionService', () => {
  it('runs tokens, archive, then the inbox prune, in that order, and returns all counts', async () => {
    const pool = fakePool([]);
    const result = await new MessagingRetentionService(pool).run();

    expect(result).toEqual({
      outboxDeleted: 226,
      bulkDeleted: 40,
      tokensDeleted: 1501,
      talentumInboxPayloadsCleared: 0,
      talentumInboxDeleted: 0,
    });
    const calls = pool.query.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain('cleanup_expired_tokens()');
    expect(calls[1]).toContain('archive_old_messages()');
    expect(calls[2]).toContain('UPDATE talentum_webhook_inbox');
    expect(calls[3]).toContain('DELETE FROM talentum_webhook_inbox');
  });

  it('inbox: PROCESSED 8d loses payload; FAILED 30d keeps it; anything 91d is deleted', async () => {
    const rows: InboxRow[] = [
      { state: 'PROCESSED', processedAgeDays: 8, receivedAgeDays: 8, payload: 'enc-a' },
      { state: 'PROCESSED', processedAgeDays: 3, receivedAgeDays: 3, payload: 'enc-b' },
      { state: 'FAILED', processedAgeDays: 30, receivedAgeDays: 30, payload: 'enc-c' },
      { state: 'UNSUPPORTED', processedAgeDays: 30, receivedAgeDays: 30, payload: 'enc-d' },
      { state: 'REJECTED_SCHEMA', processedAgeDays: 30, receivedAgeDays: 30, payload: 'enc-e' },
      { state: 'FAILED', processedAgeDays: 91, receivedAgeDays: 91, payload: 'enc-f' },
      { state: 'PROCESSED', processedAgeDays: 91, receivedAgeDays: 91, payload: null },
    ];
    const result = await new MessagingRetentionService(fakePool(rows)).run();

    expect(result.talentumInboxPayloadsCleared).toBe(1);
    expect(result.talentumInboxDeleted).toBe(2);
    expect(rows.map((r) => r.payload)).toEqual([null, 'enc-b', 'enc-c', 'enc-d', 'enc-e']);
    expect(rows.map((r) => r.state)).toEqual(['PROCESSED', 'PROCESSED', 'FAILED', 'UNSUPPORTED', 'REJECTED_SCHEMA']);
  });
});
