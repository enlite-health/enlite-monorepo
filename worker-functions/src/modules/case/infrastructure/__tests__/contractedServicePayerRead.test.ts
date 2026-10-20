/**
 * contractedServicePayerRead (§G/§D) — spec 058 T051. Unidade com `q` mockado: prova a FORMA do contrato (todo id no Map, wire do
 * `validTo`, `isPrivate`, os 6 estados). A prova do SQL contra o Postgres real é de `tests/e2e/058a-ficha-vs-rota.e2e.test.ts`.
 */
import {
  batchEntry,
  derivePayerCoverageMatch,
  payerAtMany,
  payerHistoryMany,
  type CoverageEntryLike,
  type PayerRead,
} from '../contractedServicePayerRead';

const NAMES = { providerCode: 'OSDE', providerName: 'OSDE', contractId: 'c1', contractName: 'OSDE 210', payerKind: 'OBRA_SOCIAL' as const };
const LINKED: PayerRead = { state: 'LINKED', isPrivate: false, validFrom: '2026-01-01', validTo: null, names: NAMES };
const PRIVATE: PayerRead = { state: 'LINKED', isPrivate: true, validFrom: '2026-01-01', validTo: null, names: { ...NAMES, providerCode: 'PRIVATE', payerKind: 'PRIVATE' } };
const NO_CONTRACT: PayerRead = { state: 'NO_CONTRACT' };

function row(serviceId: string, over: Record<string, unknown> = {}) {
  return {
    link_id: `l-${serviceId}`, contracted_service_id: serviceId, valid: '[2026-01-01,)', contract_id: 'c1', contract_name: 'OSDE 210',
    provider_code: 'OSDE', provider_name: 'OSDE', payer_kind: 'OBRA_SOCIAL', ...over,
  };
}
const q = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue({ rows }) });

describe('payerAtMany', () => {
  it('lote sem buraco: 3 ids pedidos, o 3º sem vínculo -> 3 chaves, a 3ª NO_CONTRACT', async () => {
    const out = await payerAtMany(q([row('s1'), row('s2')]) as never, ['s1', 's2', 's3'], '2026-10-19');
    expect([...out.keys()]).toEqual(['s1', 's2', 's3']);
    expect(out.get('s3')).toEqual({ state: 'NO_CONTRACT' });
    expect(out.get('s1')).toMatchObject({ state: 'LINKED', isPrivate: false, validFrom: '2026-01-01', validTo: null });
  });

  it('uma SQL só, em lote (ANY), só vivas, com a data por parâmetro (nenhum "hoje" no SQL)', async () => {
    const cli = q([row('s1')]);
    await payerAtMany(cli as never, ['s1', 's2'], '2026-10-19');
    expect(cli.query).toHaveBeenCalledTimes(1);
    const [sql, params] = cli.query.mock.calls[0];
    expect(sql).toContain('ANY($1::uuid[])');
    expect(sql).toContain('superseded_at IS NULL');
    expect(sql).toContain('valid @> $2::date');
    expect(sql).not.toMatch(/CURRENT_DATE|now\(\)/i);
    expect(params).toEqual([['s1', 's2'], '2026-10-19']);
  });

  it('o wire é inclusivo: [2026-03-01,2026-04-01) vira validTo 2026-03-31', async () => {
    const out = await payerAtMany(q([row('s1', { valid: '[2026-03-01,2026-04-01)' })]) as never, ['s1'], '2026-03-15');
    expect(out.get('s1')).toMatchObject({ validFrom: '2026-03-01', validTo: '2026-03-31' });
  });

  it('isPrivate = payer_kind PRIVATE; os names saem completos, com payerKind (a redação é da projeção)', async () => {
    const out = await payerAtMany(q([row('s1', { provider_code: 'PRIVATE', provider_name: 'Particular', payer_kind: 'PRIVATE' })]) as never, ['s1'], '2026-10-19');
    expect(out.get('s1')).toMatchObject({
      isPrivate: true,
      names: { providerCode: 'PRIVATE', providerName: 'Particular', contractId: 'c1', contractName: 'OSDE 210', payerKind: 'PRIVATE' },
    });
  });

  it('sem ids: nenhuma query', async () => {
    const cli = q([]);
    expect((await payerAtMany(cli as never, [], '2026-10-19')).size).toBe(0);
    expect(cli.query).not.toHaveBeenCalled();
  });
});

describe('payerHistoryMany', () => {
  it('todo id aparece; lista vazia = nenhum vínculo válido; as linhas vão para o serviço certo, em ordem', async () => {
    const cli = q([
      row('s1', { link_id: 'a', valid: '[2025-01-01,2026-01-01)' }),
      row('s1', { link_id: 'b', valid: '[2026-01-01,)' }),
    ]);
    const out = await payerHistoryMany(cli as never, ['s1', 's2']);
    expect(out.get('s2')).toEqual([]);
    expect(out.get('s1')!.map((h) => [h.linkId, h.validFrom, h.validTo])).toEqual([
      ['a', '2025-01-01', '2025-12-31'],
      ['b', '2026-01-01', null],
    ]);
    expect(cli.query).toHaveBeenCalledTimes(1);
    expect(String(cli.query.mock.calls[0][0])).toContain('superseded_at IS NULL');
  });
});

describe('batchEntry', () => {
  it('buraco no lote é ERRO, nunca um NO_CONTRACT inventado', () => {
    expect(() => batchEntry(new Map<string, PayerRead>(), 'x')).toThrow(/sem entrada/);
    expect(batchEntry(new Map([['x', NO_CONTRACT]]), 'x')).toEqual(NO_CONTRACT);
  });
});

describe('derivePayerCoverageMatch — 6 estados', () => {
  const mapped = (code: string): CoverageEntryLike => ({ code, mapped: true });
  const unmapped: CoverageEntryLike = { code: null, mapped: false };

  const casos: Array<[string, PayerRead, CoverageEntryLike[], string]> = [
    ['NO_PAYER: serviço sem vínculo vigente', NO_CONTRACT, [mapped('OSDE')], 'NO_PAYER'],
    ['PRIVATE_PAYER: pagador particular, mesmo com cobertura verificada', PRIVATE, [mapped('OSDE')], 'PRIVATE_PAYER'],
    ['NO_COVERAGE: há pagador e nenhuma cobertura verificada', LINKED, [], 'NO_COVERAGE'],
    ['UNMAPPED_ONLY: só cobertura sem mapeamento', LINKED, [unmapped, unmapped], 'UNMAPPED_ONLY'],
    ['MATCH: uma cobertura mapeada é a do pagador (entre outras)', LINKED, [mapped('SWISS_MEDICAL'), mapped('OSDE'), unmapped], 'MATCH'],
    ['MISMATCH: há mapeadas e nenhuma é a do pagador', LINKED, [mapped('SWISS_MEDICAL'), unmapped], 'MISMATCH'],
  ];
  it.each(casos)('%s', (_nome, payer, entries, esperado) => {
    expect(derivePayerCoverageMatch(payer, entries)).toEqual({ state: esperado });
  });

  it('é pura: o mesmo par dá o mesmo estado e não muda a entrada', () => {
    const entries = [mapped('OSDE')];
    const antes = JSON.stringify([LINKED, entries]);
    expect(derivePayerCoverageMatch(LINKED, entries)).toEqual(derivePayerCoverageMatch(LINKED, entries));
    expect(JSON.stringify([LINKED, entries])).toBe(antes);
  });
});
