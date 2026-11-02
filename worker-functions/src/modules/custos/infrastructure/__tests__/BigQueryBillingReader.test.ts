import { BigQueryBillingReader, DEFAULT_BILLING_TABLE, MAX_BYTES_BILLED, type BigQueryQueryClient } from '../BigQueryBillingReader';
import { BillingReadError, NONE_KEY } from '../../domain/types';
import { buildWindow } from '../../domain/dates';

const WINDOW = buildWindow('2026-10', '2026-10-20');

type Call = Parameters<BigQueryQueryClient['query']>[0];

function fakeClient(answer: (sql: string) => unknown[] | Error) {
  const calls: Call[] = [];
  const client: BigQueryQueryClient = {
    query: async (o) => {
      calls.push(o);
      const a = answer(o.query);
      if (a instanceof Error) throw a;
      return [a];
    },
  };
  return { client, calls };
}

const rowsFor = (sql: string): unknown[] => {
  if (sql.includes('MAX(export_time)')) return [{ data_until: { value: '2026-10-20T08:00:00.000Z' }, currency: 'BRL' }];
  if (sql.includes('invoice.month')) return [{ month: '202609', total: 100 }, { month: '202610', total: 40 }];
  if (sql.includes('LIKE')) return [{ caller: 'svc-x', funcao: 'fn-y', total: 3 }, { caller: null, funcao: null, total: 1 }];
  if (sql.includes('AS sector')) return [{ sector: NONE_KEY, total: 7 }];
  if (sql.includes('AS resource')) return [{ service: 'Cloud Run', resource: 'projects/p/services/s', total: 9 }];
  if (sql.includes('AS name') && sql.includes('resource.name')) return [{ day: '2026-10-19', name: 'res-1', total: 2 }];
  if (sql.includes('AS name')) return [{ day: '2026-10-19', name: 'Cloud Run', total: 4 }];
  if (sql.includes('AS service')) return [{ service: 'Cloud Run', total: 12 }];
  return [{ day: '2026-10-19', total: 5 }];
};

describe('BigQueryBillingReader (CA-5, parte 1)', () => {
  it('TODA consulta leva maximumBytesBilled = 1073741824, location US e parâmetros nomeados', async () => {
    const { client, calls } = fakeClient(rowsFor);
    await new BigQueryBillingReader(client).read(WINDOW);
    expect(MAX_BYTES_BILLED).toBe('1073741824');
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const c of calls) {
      expect(c.maximumBytesBilled).toBe('1073741824');
      expect(c.location).toBe('US');
      expect(Object.keys(c.params).sort()).toEqual(['from', 'to']);
      expect(c.query).toContain('usage_start_time >= TIMESTAMP(@from)');
      expect(c.query).toContain(DEFAULT_BILLING_TABLE);
      // nenhum valor de parâmetro foi interpolado no texto da consulta
      expect(c.query).not.toContain(c.params.from);
    }
  });

  it('líquido = cost + créditos em toda consulta de valor', async () => {
    const { client, calls } = fakeClient(rowsFor);
    await new BigQueryBillingReader(client).read(WINDOW);
    const valued = calls.filter((c) => !c.query.includes('MAX(export_time)'));
    expect(valued.length).toBeGreaterThanOrEqual(8);
    for (const c of valued) expect(c.query).toContain('cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)');
  });

  it('mapeia as linhas para o contrato (dataUntil ISO, meses YYYY-MM, IA sem label = unattributed)', async () => {
    const { client } = fakeClient(rowsFor);
    const d = await new BigQueryBillingReader(client).read(WINDOW);
    expect(d.currency).toBe('BRL');
    expect(d.dataUntil).toBe('2026-10-20T08:00:00.000Z');
    expect(d.months).toEqual([{ month: '2026-09', total: 100 }, { month: '2026-10', total: 40 }]);
    expect(d.dailyTotals).toEqual([{ day: '2026-10-19', value: 5 }]);
    expect(d.bySector).toEqual([{ sector: NONE_KEY, total: 7 }]);
    expect(d.byAiCaller).toEqual([
      { caller: 'svc-x', funcao: 'fn-y', total: 3, source: 'billing' },
      { caller: NONE_KEY, funcao: NONE_KEY, total: 1, source: 'unattributed' },
    ]);
    expect(d.dailyByResource[0]).toEqual({ kind: 'resource', name: 'res-1', day: '2026-10-19', value: 2 });
  });

  it('export sem linhas -> currency e dataUntil nulos (estado vazio)', async () => {
    const { client } = fakeClient((sql) => (sql.includes('MAX(export_time)') ? [{ data_until: null, currency: null }] : []));
    const d = await new BigQueryBillingReader(client).read(WINDOW);
    expect(d).toMatchObject({ currency: null, dataUntil: null, dailyTotals: [], byService: [] });
  });

  it('erro de limite de bytes -> bytes_limit, sem repassar o texto cru', async () => {
    const raw = Object.assign(new Error('Query exceeded limit for bytes billed: 1073741824. 5000000000 or higher required. SECRET-DETAIL'), {
      errors: [{ reason: 'bytesBilledLimitExceeded' }],
    });
    const { client } = fakeClient(() => raw);
    const err = await new BigQueryBillingReader(client).read(WINDOW).catch((e) => e);
    expect(err).toBeInstanceOf(BillingReadError);
    expect(err.code).toBe('bytes_limit');
    expect(err.message).toBe('bytes_limit');
    expect(JSON.stringify(err)).not.toContain('SECRET-DETAIL');
  });

  it('qualquer outro erro -> billing_query_failed, sem repassar o texto cru', async () => {
    const { client } = fakeClient(() => new Error('Access Denied: SECRET-DETAIL'));
    const err = await new BigQueryBillingReader(client).read(WINDOW).catch((e) => e);
    expect(err).toBeInstanceOf(BillingReadError);
    expect(err.code).toBe('billing_query_failed');
    expect(err.message).not.toContain('SECRET-DETAIL');
  });

  it('nome de tabela fora do padrão é recusado (único texto interpolado na SQL)', () => {
    const { client } = fakeClient(rowsFor);
    expect(() => new BigQueryBillingReader(client, 'a.b.c`; DROP TABLE x; --')).toThrow('invalid billing table name');
    expect(() => new BigQueryBillingReader(client, 'proj.ds.tabela_1')).not.toThrow();
  });
});
