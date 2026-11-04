/**
 * "Ficha × rota" (SC-001, spec 058 T055, D-44): o MESMO serviço, com o MESMO `requestNow`, devolve `asOf`, `payer`, `payerHistory`,
 * `price`, `tax` e `coverageMatch` idênticos pela ficha (`mapContractedServices`) e pela rota (`PatientContractedServiceRepository`,
 * via `decorate`) — porque os dois chamam as MESMAS funções em lote. Banco falso roteado por SQL (a prova contra o Postgres real é de
 * `tests/e2e/058a-ficha-vs-rota.e2e.test.ts`, A1.7). Schedule/authorization entram na B (SC-001 estendido): o objeto INTEIRO é idêntico.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: jest.fn(), query: mockPoolQuery }) }) },
}));

import type { Pool } from 'pg';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { mapContractedServices } from '../ContractedServiceDetailMapper';
import { PatientContractedServiceRepository } from '../PatientContractedServiceRepository';
import type { ContractedServiceProviderRepository } from '../ContractedServiceProviderRepository';
import type { CoverageEntry } from '../patientCoverageRead';

// 2026-10-19 02:00 UTC é 2026-10-18 em Buenos Aires: o asOf do serviço AR é o dia de LÁ, não o do servidor.
const NOW = new Date('2026-10-19T02:00:00Z');
const ASOF = '2026-10-18';

const base = {
  patient_id: 'pat-1', service_code: 'AT', professional_profile: null, providers_needed: 1, weekly_hours: null,
  care_location: null, start_date: null, supervision_frequency: null, guard_shift: null, provider_age_band: null, address_id: null,
  schedule: null, required_professions: null, required_sex: null, required_experience: null, worker_attributes: null, work_schedule: null,
  payment_day: null, daily_obs: null, active: true, ended_at: null, country: 'AR', created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z',
};
const SERVICES = ['s1', 's2', 's3'].map((id) => ({ ...base, id }));
const ENTRIES: CoverageEntry[] = [{ code: 'SWISS_MEDICAL', name: 'Swiss Medical', mapped: true, source: 'clickup' }];

const LINK = (id: string, over: Record<string, unknown> = {}) => ({
  link_id: `l-${id}`, contracted_service_id: id, valid: '[2026-01-01,)', contract_id: 'c1', contract_name: 'OSDE 210',
  provider_code: 'OSDE', provider_name: 'OSDE', payer_kind: 'OBRA_SOCIAL', ...over,
});
const PRICE = (id: string) => ({
  contracted_service_id: id, term_id: `t-${id}`, contract_id: 'c1', country: 'AR', hourly_rate: '1500.00', tax_rate_percent: '21.00', valid: '[2026-01-01,)',
});

/** Banco falso: s1 e s3 têm vínculo (s3 particular, sem termo); s2 não tem. Roteia pelo texto do SQL e filtra pelos ids pedidos. */
function fakeDb(extra?: (sql: string, params: unknown[]) => unknown[] | undefined) {
  const calls: string[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    const ids = (Array.isArray(params[0]) ? params[0] : [params[0]]) as string[];
    const mine = (rows: Array<Record<string, unknown> & { contracted_service_id: string }>) => rows.filter((r) => ids.includes(r.contracted_service_id));
    const ex = extra?.(sql, params);
    if (ex) return { rows: ex };
    if (/FROM contracted_service_contract csc/.test(sql) && /LEFT JOIN insurance_contract_terms/.test(sql)) {
      return { rows: mine([PRICE('s1'), { ...PRICE('s3'), term_id: null, hourly_rate: null, tax_rate_percent: null, valid: null }]) };
    }
    if (/FROM contracted_service_contract csc/.test(sql)) {
      return { rows: mine([LINK('s1'), LINK('s3', { provider_code: 'PRIVATE', provider_name: 'Particular', payer_kind: 'PRIVATE' })]) };
    }
    if (/jsonb_agg\(jsonb_build_object\('code'/.test(sql)) return { rows: [{ entries: ENTRIES }] };
    if (/^SELECT \* FROM patient_contracted_services WHERE id/.test(sql.trim())) return { rows: SERVICES.filter((s) => s.id === params[0]) };
    return { rows: [] };
  });
  return { query, calls };
}

const enc = { decrypt: jest.fn().mockResolvedValue('') } as unknown as KMSEncryptionService;
const providerRepo = { listForService: jest.fn().mockResolvedValue([]) } as unknown as ContractedServiceProviderRepository;

async function ficha(db: ReturnType<typeof fakeDb>, rows = SERVICES) {
  return mapContractedServices(rows, { query: db.query } as unknown as Pool, enc, ASOF, ENTRIES);
}
async function rota(db: ReturnType<typeof fakeDb>, id: string) {
  mockPoolQuery.mockImplementation(db.query);
  return new PatientContractedServiceRepository(providerRepo).findById(id, NOW);
}

const A_CHILDREN = ['asOf', 'payer', 'payerHistory', 'price', 'tax', 'coverageMatch'] as const;
const pick = (d: object) => Object.fromEntries(A_CHILDREN.map((k) => [k, (d as Record<string, unknown>)[k]]));

describe('ficha × rota (SC-001)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ficha × rota: asOf, payer, payerHistory, price, tax e coverageMatch idênticos nos 3 serviços (com vínculo, sem vínculo, particular)', async () => {
    const daFicha = await ficha(fakeDb());
    for (const id of ['s1', 's2', 's3']) {
      const daRota = await rota(fakeDb(), id);
      const f = daFicha.find((s) => s.id === id)!;
      expect(daRota).not.toBeNull();
      expect(pick(daRota!)).toEqual(pick(f));
    }
  });

  it('ficha × rota: o ContractedServiceDetail INTEIRO é idêntico, com agenda e autorização vindas do banco falso, mesmo requestNow', async () => {
    const FAIXA = { dayOfWeek: 1, startTime: '08:00', endTime: '12:00', durationMinutes: 240 };
    const comAgendaEAutorizacao = (sql: string, params: unknown[]): unknown[] | undefined => {
      const ids = (Array.isArray(params[0]) ? params[0] : [params[0]]) as string[];
      if (/horario_do_servico/.test(sql)) return ids.includes('s1') ? [{ id: 's1', schedule: [FAIXA] }] : [];
      if (/FROM contracted_service_authorization/.test(sql)) {
        return ids.includes('s1') ? [{ contracted_service_id: 's1', id: 'a1', hours: '40', valid: '[2026-01-01,2027-01-01)' }] : [];
      }
      return undefined;
    };
    const daFicha = await ficha(fakeDb(comAgendaEAutorizacao));
    for (const id of ['s1', 's2', 's3']) {
      const daRota = await rota(fakeDb(comAgendaEAutorizacao), id);
      expect(daRota).toEqual(daFicha.find((s) => s.id === id));
    }
    const [s1, s2] = daFicha;
    expect(s1.schedule).toEqual([FAIXA]);
    expect(s1.authorization).toEqual({ id: 'a1', hours: 40, validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(s2.schedule).toBeNull();
    expect(s2.authorization).toBeNull();
  });

  it('o conteúdo comparado é o esperado (não duas leituras vazias iguais): vínculo OSDE com preço, sem vínculo, particular sem termo', async () => {
    const [s1, s2, s3] = await ficha(fakeDb());
    expect(s1).toMatchObject({
      asOf: ASOF, // o dia de Buenos Aires, não o do servidor
      payer: { state: 'LINKED', isPrivate: false, names: { providerCode: 'OSDE' } },
      price: { state: 'OK', hourlyRate: 1500, currency: 'ARS' },
      tax: { state: 'OK', taxRatePercent: 21 },
      coverageMatch: { state: 'MISMATCH' }, // a cobertura verificada é Swiss Medical, o pagador é OSDE
    });
    expect(s2).toMatchObject({ payer: { state: 'NO_CONTRACT' }, payerHistory: [], price: { state: 'NO_CONTRACT' }, tax: { state: 'NO_CONTRACT' }, coverageMatch: { state: 'NO_PAYER' } });
    expect(s3).toMatchObject({ payer: { isPrivate: true }, price: { state: 'NO_TERM' }, tax: { state: 'NO_TERM' }, coverageMatch: { state: 'PRIVATE_PAYER' } });
  });

  it('contagem de queries: a ficha gasta +3 de pagador/preço por ficha, com 1 ou com 3 serviços; a rota (1 serviço) usa as mesmas 3 + 1 de cobertura', async () => {
    const payerQueries = (calls: string[]) => calls.filter((c) => /contracted_service_contract/.test(c)).length;
    const um = fakeDb();
    await ficha(um, SERVICES.slice(0, 1));
    const tres = fakeDb();
    await ficha(tres, SERVICES);
    expect(payerQueries(um.calls)).toBe(3);
    expect(payerQueries(tres.calls)).toBe(3);
    expect(um.query).toHaveBeenCalledTimes(tres.query.mock.calls.length); // nenhuma query a mais por serviço

    const r = fakeDb();
    await rota(r, 's1');
    expect(payerQueries(r.calls)).toBe(3);
    expect(r.calls.filter((c) => /jsonb_agg\(jsonb_build_object\('code'/.test(c))).toHaveLength(1);
  });
});
