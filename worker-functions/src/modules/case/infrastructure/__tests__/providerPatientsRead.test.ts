/** providerPatientsRead (§L) — spec 058 T053. `q` mockado; o SQL com o mapa por país é provado no Postgres real (e2e da A1.7). */
import { buildAsOfByCountry } from '@shared/locale/operationDate';
import { providerPatientsRead } from '../providerPatientsRead';

function row(over: Record<string, unknown>) {
  return { patient_id: 'p1', case_number: '766', contracted_service_id: 's1', contract_name: 'OSDE 210', valid: '[2026-01-01,)', country: 'AR', ...over };
}
const q = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue({ rows }) });

describe('providerPatientsRead', () => {
  it('§L fusos: cada item leva o asOf do SEU país (mapa AR/BR de fusos distintos, relógio congelado)', async () => {
    // 2026-10-19 12:30 UTC: Auckland já é dia 20 (UTC+13), Honolulu ainda é dia 19 (UTC-10).
    const asOfByCountry = buildAsOfByCountry({ AR: 'Pacific/Auckland', BR: 'Pacific/Honolulu' }, new Date('2026-10-19T12:30:00Z'));
    expect(asOfByCountry).toEqual({ AR: '2026-10-20', BR: '2026-10-19' });
    const cli = q([row({ country: 'AR' }), row({ patient_id: 'p2', contracted_service_id: 's2', country: 'BR' })]);
    const out = await providerPatientsRead(cli as never, 'OSDE', asOfByCountry);
    expect(out.map((i) => [i.patientId, i.asOf])).toEqual([['p1', '2026-10-20'], ['p2', '2026-10-19']]);
    // o mapa inteiro vai como parâmetro: o SQL compara por linha com ($2 ->> pcs.country)::date
    const [sql, params] = cli.query.mock.calls[0];
    expect(sql).toContain("($2::jsonb ->> pcs.country)::date");
    expect(JSON.parse(params[1] as string)).toEqual(asOfByCountry);
  });

  it('o item não carrega nenhum campo de container de paciente: só as 7 chaves do contrato; validTo inclusivo', async () => {
    const out = await providerPatientsRead(q([row({ valid: '[2026-01-01,2026-06-01)' })]) as never, 'OSDE', { AR: '2026-03-01' });
    expect(Object.keys(out[0]).sort()).toEqual(['asOf', 'caseNumber', 'contractName', 'contractedServiceId', 'patientId', 'validFrom', 'validTo']);
    expect(out[0]).toMatchObject({ validFrom: '2026-01-01', validTo: '2026-05-31', caseNumber: 766 });
  });

  it('nenhum vínculo vigente -> []; caso sem número -> caseNumber null; erro de banco é erro (não vira [])', async () => {
    expect(await providerPatientsRead(q([]) as never, 'OSDE', { AR: '2026-03-01' })).toEqual([]);
    expect((await providerPatientsRead(q([row({ case_number: null })]) as never, 'OSDE', { AR: '2026-03-01' }))[0].caseNumber).toBeNull();
    const quebrado = { query: jest.fn().mockRejectedValue(new Error('conexão caiu')) };
    await expect(providerPatientsRead(quebrado as never, 'OSDE', { AR: '2026-03-01' })).rejects.toThrow('conexão caiu');
  });

  it('SQL: só vivas, nenhum "hoje" no SQL, código do pagador por parâmetro', async () => {
    const cli = q([]);
    await providerPatientsRead(cli as never, 'OSDE', { AR: '2026-03-01' });
    const [sql, params] = cli.query.mock.calls[0];
    expect(sql).toContain('csc.superseded_at IS NULL');
    expect(sql).not.toMatch(/CURRENT_DATE|now\(\)/i);
    expect(params[0]).toBe('OSDE');
  });
});
