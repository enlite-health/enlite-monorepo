/**
 * insuranceContractTermWriter (§W; spec 058 §3.2, plan §1.3) — contrato com o 1º termo na MESMA transação, termo novo, `REPRICED`/`CORRECTION`.
 * Termo é imutável: nunca UPDATE de valor; o vivo só recebe `superseded_by`/`superseded_reason` (o `superseded_at` é do trigger).
 * O que o banco aceita (EXCLUDE, trigger de imutabilidade, T5) é provado no e2e de banco; aqui o cliente é falso e registra o SQL na ordem.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockClientQuery = jest.fn();
const mockWithActor = jest.fn(async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ query: mockClientQuery }));
jest.mock('@shared/database/actorContext', () => ({ withActorContext: (...a: [unknown, (c: unknown) => Promise<unknown>]) => mockWithActor(...a) }));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) } }));

import {
  InsuranceContractTermWriter,
  ProviderNotFoundError,
  ContractNotFoundError,
  TermNotFoundError,
  TermAlreadySupersededError,
} from '../insuranceContractTermWriter';
import { InsuranceContractNameExistsError } from '../InsuranceProviderRepository';
import { SameStartUseCorrectionError, RangeInvalidError } from '../../domain/rangeWriteErrors';

const CONTRACT = '33333333-3333-4333-8333-333333333333';
const TERM = '55555555-5555-4555-8555-555555555555';
const ACTOR = 'uid-admin';

interface Script {
  provider?: boolean;
  contract?: boolean;
  term?: { hourly_rate: string; tax_rate_percent: string; valid: string; superseded_at: Date | null } | null;
  failOn?: (sql: string) => unknown;
}

function script(s: Script = {}): void {
  const { provider = true, contract = true } = s;
  const term = s.term === undefined ? { hourly_rate: '1500.00', tax_rate_percent: '21.00', valid: '[2026-03-01,)', superseded_at: null } : s.term;
  let nextId = 0;
  mockClientQuery.mockImplementation(async (sql: string) => {
    const f = s.failOn?.(sql);
    if (f) throw f;
    if (/FROM insurance_providers/.test(sql)) return { rows: provider ? [{}] : [], rowCount: provider ? 1 : 0 };
    if (/FROM insurance_contracts/.test(sql)) return { rows: contract ? [{}] : [], rowCount: contract ? 1 : 0 };
    if (/FROM insurance_contract_terms/.test(sql)) return { rows: term ? [term] : [], rowCount: term ? 1 : 0 };
    if (/^\s*INSERT INTO insurance_contracts/.test(sql)) return { rows: [{ id: CONTRACT }], rowCount: 1 };
    if (/^\s*INSERT INTO insurance_contract_terms/.test(sql)) return { rows: [{ id: `term-${++nextId}` }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
}

const writes = (): Array<[string, unknown[]]> =>
  mockClientQuery.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE)/.test(sql as string)).map(([sql, p]) => [sql as string, p as unknown[]]);

describe('InsuranceContractTermWriter', () => {
  const writer = new InsuranceContractTermWriter();
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockWithActor.mockClear();
    script();
  });

  it('createContract: contrato + 1º termo na MESMA transação (um withActorContext), nessa ordem; vigência pelo wire', async () => {
    const r = await writer.createContract(
      { providerCode: 'OSDE', name: 'OSDE 210', country: 'AR', scopeDescription: null, firstTerm: { hourlyRate: 1500, taxRatePercent: 0, validFrom: '2026-10-19', validTo: '2026-12-31' } },
      ACTOR,
    );
    expect(r).toEqual({ contractId: CONTRACT, termId: 'term-1' });
    expect(mockWithActor).toHaveBeenCalledTimes(1);
    const w = writes();
    expect(w[0][0]).toMatch(/INSERT INTO insurance_contracts/);
    expect(w[0][1]).toEqual(['OSDE', 'AR', 'OSDE 210', null, ACTOR]);
    expect(w[1][0]).toMatch(/INSERT INTO insurance_contract_terms/);
    expect(w[1][1]).toEqual([CONTRACT, 1500, 0, '[2026-10-19,2027-01-01)', ACTOR]);
  });

  it('createContract: imposto 0 ("isento") é gravado como 0 — nunca vira DEFAULT nem null', async () => {
    await writer.createContract({ providerCode: 'OSDE', name: 'C', country: 'AR', scopeDescription: null, firstTerm: { hourlyRate: 10, taxRatePercent: 0, validFrom: '2026-10-19', validTo: null } }, ACTOR);
    expect(writes()[1][1][2]).toBe(0);
  });

  it('createContract: obra social inexistente → 404; nome repetido (contracts_name_uq) → 409 tipado; T5 (P0001) passa cru', async () => {
    script({ provider: false });
    await expect(writer.createContract({ providerCode: 'NADA', name: 'C', country: 'AR', scopeDescription: null, firstTerm: { hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-10-19', validTo: null } }, ACTOR)).rejects.toBeInstanceOf(ProviderNotFoundError);
    script({ failOn: (sql) => (/^\s*INSERT INTO insurance_contracts/.test(sql) ? Object.assign(new Error('dup'), { code: '23505', constraint: 'insurance_contracts_name_uq' }) : null) });
    await expect(writer.createContract({ providerCode: 'OSDE', name: 'C', country: 'AR', scopeDescription: null, firstTerm: { hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-10-19', validTo: null } }, ACTOR)).rejects.toBeInstanceOf(InsuranceContractNameExistsError);
    const t5 = Object.assign(new Error('PAYER_KIND_REQUIRED'), { code: 'P0001' });
    script({ failOn: (sql) => (/^\s*INSERT INTO insurance_contracts/.test(sql) ? t5 : null) });
    await expect(writer.createContract({ providerCode: 'OSDE', name: 'C', country: 'AR', scopeDescription: null, firstTerm: { hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-10-19', validTo: null } }, ACTOR)).rejects.toBe(t5);
  });

  it('addTerm: INSERT de termo novo (nunca UPDATE); contrato inexistente → 404; sobreposição (23P01) passa cru', async () => {
    await writer.addTerm(CONTRACT, { hourlyRate: 1700, taxRatePercent: 10.5, validFrom: '2027-01-01', validTo: null }, ACTOR);
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1]).toEqual([CONTRACT, 1700, 10.5, '[2027-01-01,)', ACTOR]);
    script({ contract: false });
    await expect(writer.addTerm(CONTRACT, { hourlyRate: 1, taxRatePercent: 0, validFrom: '2027-01-01', validTo: null }, ACTOR)).rejects.toBeInstanceOf(ContractNotFoundError);
    const overlap = Object.assign(new Error('overlap'), { code: '23P01' });
    script({ failOn: (sql) => (/^\s*INSERT/.test(sql) ? overlap : null) });
    await expect(writer.addTerm(CONTRACT, { hourlyRate: 1, taxRatePercent: 0, validFrom: '2027-01-01', validTo: null }, ACTOR)).rejects.toBe(overlap);
  });

  it('supersedeTerm REPRICED: marca o vivo (só by/reason), re-insere [início, novo) com os valores ANTIGOS e insere o novo', async () => {
    const r = await writer.supersedeTerm(CONTRACT, TERM, { reason: 'REPRICED', hourlyRate: 1800, taxRatePercent: 21, validFrom: '2026-07-01' }, ACTOR);
    const w = writes();
    expect(w).toHaveLength(3);
    expect(w[0][0]).toMatch(/UPDATE insurance_contract_terms SET superseded_by = \$2, superseded_reason = \$3 WHERE id = \$1/);
    expect(w[0][1]).toEqual([TERM, ACTOR, 'REPRICED']);
    expect(w[1][1]).toEqual([CONTRACT, 1500, 21, '[2026-03-01,2026-07-01)', ACTOR]);
    expect(w[2][1]).toEqual([CONTRACT, 1800, 21, '[2026-07-01,)', ACTOR]);
    expect(r.termId).toBe('term-2');
    expect(w.map(([sql]) => sql).join('\n')).not.toMatch(/hourly_rate\s*=|superseded_at|now\(\)|CURRENT_DATE/i);
  });

  it('SAME_START: reajuste com validFrom igual ao início do termo vivo é recusado ANTES do banco — nada marcado', async () => {
    await expect(writer.supersedeTerm(CONTRACT, TERM, { reason: 'REPRICED', hourlyRate: 1800, taxRatePercent: 21, validFrom: '2026-03-01' }, ACTOR)).rejects.toBeInstanceOf(SameStartUseCorrectionError);
    expect(writes()).toEqual([]);
  });

  it('supersedeTerm CORRECTION: substitui o termo inteiro (sem reinsert), herdando o fim do substituído quando validTo é omitido', async () => {
    script({ term: { hourly_rate: '1500.00', tax_rate_percent: '21.00', valid: '[2026-03-01,2026-09-01)', superseded_at: null } });
    await writer.supersedeTerm(CONTRACT, TERM, { reason: 'CORRECTION', hourlyRate: 1450, taxRatePercent: 21, validFrom: '2026-03-01' }, ACTOR);
    const w = writes();
    expect(w).toHaveLength(2);
    expect(w[0][1]).toEqual([TERM, ACTOR, 'CORRECTION']);
    expect(w[1][1]).toEqual([CONTRACT, 1450, 21, '[2026-03-01,2026-09-01)', ACTOR]);
    mockClientQuery.mockClear();
    script({ term: { hourly_rate: '1500.00', tax_rate_percent: '21.00', valid: '[2026-03-01,2026-09-01)', superseded_at: null } });
    await writer.supersedeTerm(CONTRACT, TERM, { reason: 'CORRECTION', hourlyRate: 1450, taxRatePercent: 21, validFrom: '2026-03-01', validTo: null }, ACTOR);
    expect(writes()[1][1][3]).toBe('[2026-03-01,)');
  });

  it('supersedeTerm: termo inexistente → 404, já substituído → 409, vigência fora do termo → TERM_RANGE_INVALID', async () => {
    script({ term: null });
    await expect(writer.supersedeTerm(CONTRACT, TERM, { reason: 'CORRECTION', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-03-01' }, ACTOR)).rejects.toBeInstanceOf(TermNotFoundError);
    script({ term: { hourly_rate: '1.00', tax_rate_percent: '0.00', valid: '[2026-03-01,)', superseded_at: new Date('2026-04-01') } });
    await expect(writer.supersedeTerm(CONTRACT, TERM, { reason: 'CORRECTION', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-03-01' }, ACTOR)).rejects.toBeInstanceOf(TermAlreadySupersededError);
    script({ term: { hourly_rate: '1.00', tax_rate_percent: '0.00', valid: '[2026-03-01,2026-05-01)', superseded_at: null } });
    const depois = await writer.supersedeTerm(CONTRACT, TERM, { reason: 'REPRICED', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-08-01' }, ACTOR).catch((e) => e);
    expect(depois).toBeInstanceOf(RangeInvalidError);
    expect(depois.code).toBe('TERM_RANGE_INVALID');
    const antes = await writer.supersedeTerm(CONTRACT, TERM, { reason: 'REPRICED', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-01-01' }, ACTOR).catch((e) => e);
    expect(antes).toBeInstanceOf(RangeInvalidError);
    const fimAntes = await writer.supersedeTerm(CONTRACT, TERM, { reason: 'CORRECTION', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-06-01' }, ACTOR).catch((e) => e);
    expect(fimAntes).toBeInstanceOf(RangeInvalidError);
    expect(writes()).toEqual([]);
  });

  it('D-43: o arquivo do escritor não tem CURRENT_DATE nem now() em SQL, nem conversão de daterange própria', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'insuranceContractTermWriter.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(src).not.toMatch(/CURRENT_DATE|now\(\)|NOW\(\)|::daterange/);
  });
});
