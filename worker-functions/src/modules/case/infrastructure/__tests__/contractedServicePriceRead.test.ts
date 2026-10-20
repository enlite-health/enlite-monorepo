/** contractedServicePriceRead (§P) — spec 058 T052. `q` mockado; o SQL real é provado em `tests/e2e/058a-ficha-vs-rota.e2e.test.ts`. */
import { priceStateMany } from '../contractedServicePriceRead';

function row(serviceId: string, over: Record<string, unknown> = {}) {
  return {
    contracted_service_id: serviceId, term_id: `t-${serviceId}`, contract_id: 'c1', country: 'AR',
    hourly_rate: '1500.00', tax_rate_percent: '21.00', valid: '[2026-01-01,)', ...over,
  };
}
const q = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue({ rows }) });

describe('priceStateMany', () => {
  it('lote sem buraco: 3 ids pedidos, o 3º sem vínculo -> 3 chaves, a 3ª NO_CONTRACT (preço e imposto)', async () => {
    const out = await priceStateMany(q([row('s1'), row('s2')]) as never, ['s1', 's2', 's3'], '2026-10-19');
    expect([...out.keys()]).toEqual(['s1', 's2', 's3']);
    expect(out.get('s3')).toEqual({ price: { state: 'NO_CONTRACT' }, tax: { state: 'NO_CONTRACT' } });
  });

  it('com termo vigente: preço OK com moeda do país do CONTRATO e imposto OK, numéricos convertidos', async () => {
    const out = await priceStateMany(q([row('s1'), row('s2', { country: 'BR', hourly_rate: '80.50', tax_rate_percent: '5.00' })]) as never, ['s1', 's2'], '2026-10-19');
    expect(out.get('s1')).toEqual({ price: { state: 'OK', hourlyRate: 1500, currency: 'ARS' }, tax: { state: 'OK', taxRatePercent: 21 } });
    expect(out.get('s2')).toEqual({ price: { state: 'OK', hourlyRate: 80.5, currency: 'BRL' }, tax: { state: 'OK', taxRatePercent: 5 } });
  });

  it('vínculo vigente mas contrato sem termo vigente hoje -> NO_TERM nos dois (NOT_DEFINED não existe)', async () => {
    const out = await priceStateMany(q([row('s1', { term_id: null, hourly_rate: null, tax_rate_percent: null, valid: null })]) as never, ['s1'], '2026-10-19');
    expect(out.get('s1')).toEqual({ price: { state: 'NO_TERM' }, tax: { state: 'NO_TERM' } });
  });

  it('país sem moeda lança (nunca inventa moeda)', async () => {
    await expect(priceStateMany(q([row('s1', { country: 'CL' })]) as never, ['s1'], '2026-10-19')).rejects.toThrow(/sem moeda/);
  });

  it('UMA SQL em lote, data por parâmetro, só vivas, nenhum "hoje" no SQL', async () => {
    const cli = q([row('s1')]);
    await priceStateMany(cli as never, ['s1', 's2'], '2026-10-19');
    expect(cli.query).toHaveBeenCalledTimes(1);
    const [sql, params] = cli.query.mock.calls[0];
    expect(sql).toContain('ANY($1::uuid[])');
    expect(sql).toContain('csc.superseded_at IS NULL');
    expect(sql).toContain('t.superseded_at IS NULL');
    expect(sql).not.toMatch(/CURRENT_DATE|now\(\)/i);
    expect(params).toEqual([['s1', 's2'], '2026-10-19']);
  });
});
