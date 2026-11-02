import { BigQueryBillingReader, DEFAULT_AI_USAGE_TABLE, DEFAULT_BILLING_TABLE, MAX_BYTES_BILLED, type BigQueryQueryClient } from '../BigQueryBillingReader';
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

const isAi = (sql: string): boolean => sql.includes('jsonPayload');
const billingOnly = (calls: Call[]): Call[] => calls.filter((c) => !isAi(c.query));

const rowsFor = (sql: string): unknown[] => {
  if (isAi(sql)) return [];
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
    expect(billingOnly(calls).length).toBeGreaterThanOrEqual(9);
    expect(calls.filter((c) => isAi(c.query))).toHaveLength(1);
    for (const c of calls) {
      expect(c.maximumBytesBilled).toBe('1073741824');
      expect(c.location).toBe('US');
      expect(Object.keys(c.params).sort()).toEqual(['from', 'to']);
      expect(c.query).toContain(isAi(c.query) ? 'timestamp >= TIMESTAMP(@from)' : 'usage_start_time >= TIMESTAMP(@from)');
      expect(c.query).toContain(isAi(c.query) ? DEFAULT_AI_USAGE_TABLE : DEFAULT_BILLING_TABLE);
      // nenhum valor de parâmetro foi interpolado no texto da consulta
      expect(c.query).not.toContain(c.params.from);
    }
  });

  it('líquido = cost + créditos em toda consulta de valor', async () => {
    const { client, calls } = fakeClient(rowsFor);
    await new BigQueryBillingReader(client).read(WINDOW);
    const valued = billingOnly(calls).filter((c) => !c.query.includes('MAX(export_time)'));
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

  describe('custo ESTIMADO da IA (T056, DF-10)', () => {
    const aiRows = [
      { caller: 'worker-functions', funcao: 'parser_vaga', model: 'gemini-2.5-flash', tokens_in: 2_000_000, tokens_out: 1_000_000 },
      { caller: 'triage-service', funcao: 'luz_turno', model: 'gemini-2.5-flash', tokens_in: 1_000_000, tokens_out: 0 },
      { caller: 'sol', funcao: 'propagador', model: 'modelo-sem-preco', tokens_in: 10, tokens_out: 10 },
      { caller: 'sol', funcao: 'propagador', model: 'gemini-2.5-flash', tokens_in: 10, tokens_out: 10 },
    ];
    const withAi = (rows: unknown[] | Error) => (sql: string) => (isAi(sql) ? rows : rowsFor(sql));

    it('agrega tokens × tabela de preço, source estimated; modelo sem preço -> total null (nunca 0)', async () => {
      const { client, calls } = fakeClient(withAi(aiRows));
      const d = await new BigQueryBillingReader(client).read(WINDOW);
      const est = d.byAiCaller.filter((r) => r.source === 'estimated');
      expect(est).toEqual([
        { caller: 'worker-functions', funcao: 'parser_vaga', total: 0.6 + 2.5, source: 'estimated' },
        { caller: 'triage-service', funcao: 'luz_turno', total: 0.3, source: 'estimated' },
        { caller: 'sol', funcao: 'propagador', total: null, source: 'estimated' },
      ]);
      // a janela é o MÊS e a consulta soma por service/funcao/model; trilha do billing segue intacta
      const ai = calls.find((c) => isAi(c.query))!;
      expect(ai.params).toEqual({ from: WINDOW.monthStart, to: WINDOW.monthEndExclusive });
      expect(ai.query).toContain('GROUP BY caller, funcao, model');
      expect(d.byAiCaller.filter((r) => r.source !== 'estimated')).toHaveLength(2);
    });

    it('tabela ausente (404 / notFound) -> [] sem erro; o resto da leitura continua', async () => {
      for (const missing of [Object.assign(new Error('Not found: Table'), { code: 404 }), Object.assign(new Error('x'), { errors: [{ reason: 'notFound' }] }), Object.assign(new Error('failed to analyze: INVALID_ARGUMENT: Table not found: `p.d.t` [at 1:15]'), { code: 400 })]) {
        const { client } = fakeClient(withAi(missing));
        const d = await new BigQueryBillingReader(client).read(WINDOW);
        expect(d.byAiCaller.filter((r) => r.source === 'estimated')).toEqual([]);
        expect(d.byService).toHaveLength(1);
      }
    });

    it('outro erro na consulta de IA -> billing_query_failed (não é tabela ausente)', async () => {
      const { client } = fakeClient(withAi(new Error('Access Denied: SECRET-DETAIL')));
      const err = await new BigQueryBillingReader(client).read(WINDOW).catch((e) => e);
      expect(err).toBeInstanceOf(BillingReadError);
      expect(err.code).toBe('billing_query_failed');
    });

    it('nome da tabela de IA fora do padrão é recusado', () => {
      const { client } = fakeClient(rowsFor);
      expect(() => new BigQueryBillingReader(client, undefined, 'a.b.c`; DROP --')).toThrow('invalid ai usage table name');
    });
  });
});
