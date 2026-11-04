import type { PoolClient } from 'pg';
import { EnquadreEventListRepository, type EnquadreListFilters } from '../EnquadreEventListRepository';

const F: EnquadreListFilters = {
  countries: ['AR'], from: null, to: null, statuses: null, host: null,
  eventCodeLike: null, digitsLike: null, ordinal: null, limit: 20, offset: 0,
};

describe('EnquadreEventListRepository — hosts (spec 076)', () => {
  it('hosts vem de TODOS os eventos do escopo de país (não do conjunto filtrado), limitado a 200', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await new EnquadreEventListRepository().list({ query } as unknown as PoolClient, F);
    const sql = query.mock.calls[0][0] as string;
    const hosts = sql.slice(sql.indexOf('AS hosts') - 400, sql.indexOf('AS hosts'));
    expect(hosts).toContain('FROM enquadre_events e');
    expect(hosts).toContain('e.country = ANY($1::text[])');
    expect(hosts).toContain('LIMIT 200');
    expect(hosts).not.toMatch(/FROM base/);
    expect(hosts).not.toContain('host_email');
  });
});
