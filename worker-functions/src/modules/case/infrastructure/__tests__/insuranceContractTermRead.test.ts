/** insuranceContractTermRead (§T) — spec 058 T050. `q` mockado; o SQL contra o Postgres real é provado nos e2e de banco da A1.7. */
import {
  countFutureTerms,
  liveTermContainingSql,
  offeredContractsOf,
  termAt,
  termsOfContracts,
  termView,
} from '../insuranceContractTermRead';

function term(id: string, contractId: string, valid: string, over: Record<string, unknown> = {}) {
  return { id, contract_id: contractId, country: 'AR', hourly_rate: '1500.00', tax_rate_percent: '21.00', valid, ...over };
}
const q = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue({ rows }) });
const ASOF = '2026-10-19';

describe('termsOfContracts', () => {
  it('todo contrato pedido aparece; vigente = começa até asOf; futuros = começam depois, em ordem', async () => {
    const out = await termsOfContracts(
      q([
        term('t1', 'c1', '[2026-01-01,2026-12-01)'),
        term('t2', 'c1', '[2026-12-01,)'),
        term('t3', 'c2', '[2027-01-01,)'),
      ]) as never,
      ['c1', 'c2', 'c3'],
      ASOF,
    );
    expect([...out.keys()]).toEqual(['c1', 'c2', 'c3']);
    expect(out.get('c1')!.current).toMatchObject({ termId: 't1', validFrom: '2026-01-01', validTo: '2026-11-30' });
    expect(out.get('c1')!.future.map((t) => t.termId)).toEqual(['t2']);
    expect(out.get('c2')).toMatchObject({ current: null });
    expect(out.get('c2')!.future.map((t) => t.termId)).toEqual(['t3']);
    expect(out.get('c3')).toEqual({ current: null, future: [] });
  });

  it('um termo que começa EXATAMENTE em asOf é o vigente (fronteira inclusiva)', async () => {
    const out = await termsOfContracts(q([term('t1', 'c1', '[2026-10-19,)')]) as never, ['c1'], ASOF);
    expect(out.get('c1')!.current?.termId).toBe('t1');
    expect(out.get('c1')!.future).toEqual([]);
  });

  it('UMA SQL em lote, só vivas, data por parâmetro, nenhum "hoje" no SQL', async () => {
    const cli = q([]);
    await termsOfContracts(cli as never, ['c1', 'c2'], ASOF);
    expect(cli.query).toHaveBeenCalledTimes(1);
    const [sql, params] = cli.query.mock.calls[0];
    expect(sql).toContain('ANY($1::uuid[])');
    expect(sql).toContain('t.superseded_at IS NULL');
    expect(sql).not.toMatch(/CURRENT_DATE|now\(\)/i);
    expect(params).toEqual([['c1', 'c2'], ASOF]);
  });

  it('sem ids: Map vazio e nenhuma query', async () => {
    const cli = q([]);
    expect((await termsOfContracts(cli as never, [], ASOF)).size).toBe(0);
    expect(cli.query).not.toHaveBeenCalled();
  });
});

describe('termAt', () => {
  it('devolve o termo vivo que contém a data, ou null; consulta com o predicado único', async () => {
    const cli = q([term('t1', 'c1', '[2026-01-01,)')]);
    expect(await termAt(cli as never, 'c1', ASOF)).toMatchObject({ termId: 't1', hourlyRate: 1500, taxRatePercent: 21, country: 'AR' });
    expect(String(cli.query.mock.calls[0][0])).toContain(liveTermContainingSql('t', '$2'));
    expect(await termAt(q([]) as never, 'c1', ASOF)).toBeNull();
  });
});

describe('offeredContractsOf', () => {
  it('"oferecido" = termo vivo que alcança asOf ou o futuro (upper infinito ou > asOf): a SQL pede overlap com [asOf, infinito)', async () => {
    const cli = q([{ id: 'c1', name: 'OSDE 210', country: 'AR', scope_description: null }]);
    const out = await offeredContractsOf(cli as never, 'OSDE', 'AR', ASOF);
    expect(out).toEqual([{ id: 'c1', name: 'OSDE 210', country: 'AR', scopeDescription: null }]);
    const [sql, params] = cli.query.mock.calls[0];
    expect(sql).toContain('t.superseded_at IS NULL');
    expect(sql).toContain('daterange($3::date, NULL)');
    expect(sql).not.toMatch(/CURRENT_DATE|now\(\)/i);
    expect(params).toEqual(['OSDE', 'AR', ASOF]);
  });
});

describe('countFutureTerms', () => {
  it('todo id aparece (0 = nenhum termo futuro); a contagem vem do banco como texto e vira número', async () => {
    const out = await countFutureTerms(q([{ contract_id: 'c1', n: '2' }]) as never, ['c1', 'c2'], ASOF);
    expect(out.get('c1')).toBe(2);
    expect(out.get('c2')).toBe(0);
  });
});

describe('termView', () => {
  it('sem termo -> NO_TERM', () => {
    expect(termView(null)).toEqual({ state: 'NO_TERM' });
  });

  it('com termo -> OK completo, sem ator; a moeda é a do país do CONTRATO', () => {
    const base = { termId: 't1', contractId: 'c1', hourlyRate: 80.5, taxRatePercent: 5, validFrom: '2026-01-01', validTo: null };
    expect(termView({ ...base, country: 'BR' })).toEqual({
      state: 'OK', termId: 't1', validFrom: '2026-01-01', validTo: null, taxRatePercent: 5, price: { state: 'OK', hourlyRate: 80.5, currency: 'BRL' },
    });
    expect(termView({ ...base, country: 'AR' })).toMatchObject({ price: { currency: 'ARS' } });
  });

  it('país sem moeda lança', () => {
    expect(() => termView({ termId: 't', contractId: 'c', country: 'CL', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-01-01', validTo: null })).toThrow(/sem moeda/);
  });
});
