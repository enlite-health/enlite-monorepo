import { BigQueryBillingReader, DEFAULT_AI_USAGE_TABLE, DEFAULT_BILLING_TABLE, MAX_BYTES_BILLED, type BigQueryQueryClient } from '../BigQueryBillingReader';
import { BillingReadError, NONE_KEY } from '../../domain/types';
import { DETAIL_QUERY_ROW_CAP } from '../../domain/buildAnomalyDetail';
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
  if (sql.includes('AS project')) return [{ project: 'enlite-prd', total: 75 }, { project: null, total: 1 }];
  if (sql.includes('AS month FROM')) return [{ month: '2026-10' }, { month: '2026-09' }];
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
    expect(billingOnly(calls)).toHaveLength(11);
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
    // fora da conta: MAX(export_time) e a lista de meses (só a coluna de partição, sem custo)
    const valued = billingOnly(calls).filter((c) => !c.query.includes('MAX(export_time)') && !c.query.includes('AS month FROM'));
    expect(valued).toHaveLength(9);
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
      { caller: 'svc-x', funcao: 'fn-y', total: 3, currency: 'BRL', source: 'billing' },
      { caller: NONE_KEY, funcao: NONE_KEY, total: 1, currency: 'BRL', source: 'unattributed' },
    ]);
    expect(d.dailyByResource[0]).toEqual({ kind: 'resource', name: 'res-1', day: '2026-10-19', value: 2 });
    expect(d.byProject).toEqual([{ project: 'enlite-prd', total: 75 }, { project: NONE_KEY, total: 1 }]);
    expect(d.availableMonths).toEqual(['2026-10', '2026-09']);
  });

  it('export sem linhas -> currency e dataUntil nulos (estado vazio)', async () => {
    const { client } = fakeClient((sql) => (sql.includes('MAX(export_time)') ? [{ data_until: null, currency: null }] : []));
    const d = await new BigQueryBillingReader(client).read(WINDOW);
    expect(d).toMatchObject({ currency: null, dataUntil: null, dailyTotals: [], byService: [] });
  });

  it('tabela do billing export inexistente (404 notFound / 400 "Table not found") -> overview vazio, sem erro (RF-9)', async () => {
    const missing = [
      Object.assign(new Error('Not found: Table'), { code: 404 }),
      Object.assign(new Error('x'), { errors: [{ reason: 'notFound' }] }),
      Object.assign(new Error('failed to analyze: INVALID_ARGUMENT: Table not found: `p.d.t` [at 1:15]'), { code: 400 }),
    ];
    for (const m of missing) {
      const { client } = fakeClient((sql) => (isAi(sql) ? [] : m));
      const d = await new BigQueryBillingReader(client).read(WINDOW);
      expect(d).toEqual({
        currency: null, dataUntil: null, dailyTotals: [], months: [], byService: [], byResource: [], bySector: [], byAiCaller: [], byProject: [], availableMonths: [],
        dailyByService: [], dailyByResource: [],
      });
    }
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

  it('o erro carrega reason (errors[0].reason) e causeName, nunca o message', async () => {
    const raw = Object.assign(new Error('SECRET-DETAIL'), { name: 'ApiError', errors: [{ reason: 'accessDenied' }] });
    const { client } = fakeClient(() => raw);
    const err = await new BigQueryBillingReader(client).read(WINDOW).catch((e) => e);
    expect(err).toMatchObject({ code: 'billing_query_failed', reason: 'accessDenied', causeName: 'ApiError' });
    expect(JSON.stringify(err)).not.toContain('SECRET-DETAIL');
  });

  it('nome de tabela fora do padrão é recusado (único texto interpolado na SQL)', () => {
    const { client } = fakeClient(rowsFor);
    expect(() => new BigQueryBillingReader(client, 'a.b.c`; DROP TABLE x; --')).toThrow('invalid billing table name');
    expect(() => new BigQueryBillingReader(client, 'proj.ds.tabela_1')).not.toThrow();
  });

  describe('byResource com "sem recurso" garantido (CA-17)', () => {
    it('consulta agrega TODO custo sem resource.name numa linha __none__, ordenada antes do corte (top 30 + 1)', async () => {
      const { client, calls } = fakeClient(rowsFor);
      await new BigQueryBillingReader(client).read(WINDOW);
      const q = calls.find((c) => c.query.includes('AS resource'))!.query;
      // service E resource viram __none__ quando não há resource.name: o GROUP BY colapsa todos os serviços sem recurso numa linha só
      expect(q).toContain("IF(resource.name IS NULL, '__none__', service.description) AS service");
      expect(q).toContain("IFNULL(resource.name, '__none__') AS resource");
      expect(q).toContain('GROUP BY 1, 2');
      // a linha __none__ vem 1ª: o LIMIT corta só as nomeadas (30) e ela fica de fora do corte
      expect(q).toContain("ORDER BY (resource = '__none__') DESC, total DESC LIMIT 31");
    });

    it('mapeia a linha __none__ do leitor sem perdê-la', async () => {
      const rows = [{ service: NONE_KEY, resource: NONE_KEY, total: 4.5 }, { service: 'Cloud Run', resource: 'projects/p/services/s', total: 9 }];
      const { client } = fakeClient((sql) => (isAi(sql) ? [] : sql.includes('AS resource') ? rows : rowsFor(sql)));
      const d = await new BigQueryBillingReader(client).read(WINDOW);
      expect(d.byResource).toEqual([{ service: NONE_KEY, resource: NONE_KEY, total: 4.5 }, { service: 'Cloud Run', resource: 'projects/p/services/s', total: 9 }]);
    });
  });

  describe('byProject e availableMonths (CA-20, DF-20/DF-21)', () => {
    it('byProject: soma líquida por project.id do MÊS, sem projeto = __none__, sem LIMIT', async () => {
      const { client, calls } = fakeClient(rowsFor);
      await new BigQueryBillingReader(client).read(WINDOW);
      const c = calls.find((x) => x.query.includes('AS project'))!;
      expect(c.query).toContain("IFNULL(project.id, '__none__') AS project");
      expect(c.query).toContain('cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)');
      expect(c.query).toContain('GROUP BY project ORDER BY total DESC');
      expect(c.query).not.toContain('LIMIT');
      expect(c.params).toEqual({ from: WINDOW.monthStart, to: WINDOW.monthEndExclusive });
    });

    it('availableMonths: consulta barata (só usage_start_time), janela de 13 meses a partir de HOJE, mais novo primeiro, LIMIT 13', async () => {
      const { client, calls } = fakeClient(rowsFor);
      await new BigQueryBillingReader(client).read(WINDOW);
      const c = calls.find((x) => x.query.includes('AS month FROM'))!;
      expect(c.query).toContain("FORMAT_DATE('%Y-%m', DATE(usage_start_time)) AS month");
      expect(c.query).toContain('GROUP BY month ORDER BY month DESC LIMIT 13');
      expect(c.query).not.toMatch(/labels|credits|cost/);
      // hoje = 2026-10-20 -> de 2025-10-01 (hoje − 12 meses) até 2026-10-21 (exclusivo)
      expect(c.params).toEqual({ from: '2025-10-01', to: '2026-10-21' });
      expect(c.params).toEqual({ from: WINDOW.availableFrom, to: WINDOW.availableToExclusive });
    });

    it('availableMonths devolve no máx. 13 e descarta valor fora do formato', async () => {
      const many = Array.from({ length: 15 }, (_, i) => ({ month: `2026-${String(12 - (i % 12)).padStart(2, '0')}` }));
      const { client } = fakeClient((sql) => (sql.includes('AS month FROM') ? [...many, { month: null }, { month: 'lixo' }] : rowsFor(sql)));
      const d = await new BigQueryBillingReader(client).read(WINDOW);
      expect(d.availableMonths).toHaveLength(13);
      expect(d.availableMonths.every((m) => /^\d{4}-\d{2}$/.test(m))).toBe(true);
    });
  });

  describe('readAnomalyDetail (CA-15, leitor)', () => {
    const RANGE = { from: '2026-10-01', toExclusive: '2026-10-21' };
    const detailRows = [
      { day: '2026-10-20', service: 'Cloud Run', resource: 'projects/p/services/api', total: 12.5 },
      { day: '2026-10-19', service: 'Cloud Run', resource: null, total: 3 },
    ];

    it('mesmo teto de 1 GiB, location US, parâmetros nomeados (services é array, nunca interpolado), partição por usage_start_time', async () => {
      const { client, calls } = fakeClient(() => detailRows);
      const rows = await new BigQueryBillingReader(client).readAnomalyDetail(RANGE, ['Cloud Run', "x'; DROP TABLE y; --"]);
      expect(calls).toHaveLength(1);
      const c = calls[0];
      expect(c.maximumBytesBilled).toBe('1073741824');
      expect(c.location).toBe('US');
      expect(c.params).toEqual({ from: '2026-10-01', to: '2026-10-21', services: ['Cloud Run', "x'; DROP TABLE y; --"] });
      expect(c.query).toContain('usage_start_time >= TIMESTAMP(@from) AND usage_start_time < TIMESTAMP(@to)');
      expect(c.query).toContain('service.description IN UNNEST(@services)');
      expect(c.query).toContain(DEFAULT_BILLING_TABLE);
      expect(c.query).toContain('cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)');
      expect(c.query).not.toContain('labels');
      expect(c.query).not.toContain('DROP TABLE');
      expect(c.query).toContain(`LIMIT ${DETAIL_QUERY_ROW_CAP + 1}`);
      expect(rows).toEqual([
        { day: '2026-10-20', service: 'Cloud Run', resource: 'projects/p/services/api', value: 12.5 },
        { day: '2026-10-19', service: 'Cloud Run', resource: NONE_KEY, value: 3 },
      ]);
    });

    it('exatamente DETAIL_QUERY_ROW_CAP linhas passa; uma a mais -> billing_query_failed (nunca trunca em silêncio)', async () => {
      const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ day: '2026-10-20', service: 'S', resource: `r${i}`, total: 1 }));
      const ok = await new BigQueryBillingReader(fakeClient(() => mk(DETAIL_QUERY_ROW_CAP)).client).readAnomalyDetail(RANGE, ['S']);
      expect(ok).toHaveLength(DETAIL_QUERY_ROW_CAP);
      const err = await new BigQueryBillingReader(fakeClient(() => mk(DETAIL_QUERY_ROW_CAP + 1)).client).readAnomalyDetail(RANGE, ['S']).catch((e) => e);
      expect(err).toBeInstanceOf(BillingReadError);
      expect(err).toMatchObject({ code: 'billing_query_failed', reason: 'detail_row_cap' });
    });

    it('limite de bytes -> bytes_limit e outro erro -> billing_query_failed, sem o texto cru', async () => {
      const bytes = Object.assign(new Error('SECRET-DETAIL'), { errors: [{ reason: 'bytesBilledLimitExceeded' }] });
      const e1 = await new BigQueryBillingReader(fakeClient(() => bytes).client).readAnomalyDetail(RANGE, ['S']).catch((e) => e);
      expect(e1).toMatchObject({ code: 'bytes_limit', message: 'bytes_limit' });
      const e2 = await new BigQueryBillingReader(fakeClient(() => new Error('Access Denied: SECRET-DETAIL')).client).readAnomalyDetail(RANGE, ['S']).catch((e) => e);
      expect(e2).toMatchObject({ code: 'billing_query_failed' });
      expect(JSON.stringify(e2)).not.toContain('SECRET-DETAIL');
    });

    it('tabela do billing inexistente -> [] (o read() já devolveu vazio; sem 502)', async () => {
      const missing = Object.assign(new Error('Not found: Table'), { code: 404 });
      expect(await new BigQueryBillingReader(fakeClient(() => missing).client).readAnomalyDetail(RANGE, ['S'])).toEqual([]);
    });
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
        { caller: 'worker-functions', funcao: 'parser_vaga', total: 0.6 + 2.5, currency: 'USD', source: 'estimated' },
        { caller: 'triage-service', funcao: 'luz_turno', total: 0.3, currency: 'USD', source: 'estimated' },
        { caller: 'sol', funcao: 'propagador', total: null, currency: 'USD', source: 'estimated' },
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
