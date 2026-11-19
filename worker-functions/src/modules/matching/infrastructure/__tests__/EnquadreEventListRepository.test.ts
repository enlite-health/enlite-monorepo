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

describe('EnquadreEventListRepository.listParticipantStages (spec 094)', () => {
  const sqlOf = async (ids: string[]) => {
    const query = jest.fn().mockResolvedValue({ rows: [{ event_id: 'e1', stage: 'SELECTED', outcome: null }] });
    const rows = await new EnquadreEventListRepository().listParticipantStages({ query } as unknown as PoolClient, ids);
    return { query, rows };
  };

  it('uma consulta com ANY($1), sem removed, e passa os ids como parâmetro', async () => {
    const { query, rows } = await sqlOf(['e1', 'e2']);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('ANY($1');
    expect(sql).toContain("IS DISTINCT FROM 'removed'");
    expect(sql).toContain('LEFT JOIN worker_job_applications');
    expect(query.mock.calls[0][1]).toEqual([['e1', 'e2']]);
    expect(rows).toEqual([{ event_id: 'e1', stage: 'SELECTED', outcome: null }]);
  });

  it('SELECT sem identidade (nenhum campo de worker, nome, e-mail ou telefone)', async () => {
    const { query } = await sqlOf(['e1']);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/first_name|last_name|email|phone|JOIN workers/);
  });

  it('lista vazia não consulta', async () => {
    const { query, rows } = await sqlOf([]);
    expect(query).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });
});
