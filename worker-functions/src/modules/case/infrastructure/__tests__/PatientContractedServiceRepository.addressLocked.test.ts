/**
 * 058 REGRA-05: o PATCH do serviço recusa `addressId` DIFERENTE do atual com vaga viva ou alocação vigente (422 SERVICE_ADDRESS_LOCKED).
 * Molde: PatientContractedServiceRepository.refuseClear.test.ts (client mockado; SQL real = e2e).
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }) },
}));

import { PatientContractedServiceRepository, ServiceAddressLockedError } from '../PatientContractedServiceRepository';
import type { ContractedServiceProviderRepository } from '../ContractedServiceProviderRepository';
import { isHttpDomainError } from '../../interfaces/controllers/insuranceErrorResponse';

describe('ServiceAddressLockedError', () => {
  it.each(['LIVE_VACANCY', 'ALLOCATION'] as const)('ServiceAddressLockedError: httpStatus 422, code SERVICE_ADDRESS_LOCKED e details.reason (%s)', (reason) => {
    const err = new ServiceAddressLockedError(reason);

    expect(err.httpStatus).toBe(422);
    expect(err.code).toBe('SERVICE_ADDRESS_LOCKED');
    expect(err.details).toEqual({ reason });
    expect(isHttpDomainError(err)).toBe(true);
  });
});

/** O relógio da requisição (asOf do serviço AR = 2026-09-03). */
const NOW = new Date('2026-09-03T15:00:00Z');

const SERVICE_ROW = {
  id: 'svc-1', patient_id: 'pat-1', service_code: 'AT', professional_profile: null, providers_needed: 2,
  authorized_hours: '20', care_location: 'HOME', start_date: null,
  supervision_frequency: null, guard_shift: null,
  provider_age_band: null, address_id: 'addr-A',
  schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }],
  active: true, ended_at: null, country: 'AR', created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z',
};

function fakeProviderRepo(): ContractedServiceProviderRepository {
  return { listForService: jest.fn().mockResolvedValue([]) } as unknown as ContractedServiceProviderRepository;
}

function cliente(opts: { atual?: string | null; vagaViva?: boolean; alocacoes?: number }) {
  const { atual = 'addr-A', vagaViva = false, alocacoes = 0 } = opts;
  const chamadas: string[] = [];
  const query = jest.fn(async (sql: string) => {
    chamadas.push(sql.replace(/\s+/g, ' ').trim());
    const t = sql.trim();
    if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return { rows: [], rowCount: 0 };
    if (/^SELECT address_id, country FROM patient_contracted_services/.test(t)) return { rows: [{ address_id: atual, country: 'AR' }], rowCount: 1 };
    if (/^SELECT 1 FROM job_postings/.test(t)) return { rows: vagaViva ? [{ '?column?': 1 }] : [], rowCount: vagaViva ? 1 : 0 };
    if (/^SELECT count\(\*\)::int AS n/.test(t)) return { rows: [{ n: alocacoes }], rowCount: 1 };
    if (/^UPDATE patient_contracted_services SET/.test(t)) return { rows: [], rowCount: 1 };
    if (/^SELECT \* FROM patient_contracted_services WHERE id/.test(t)) return { rows: [SERVICE_ROW], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

const repo = () => new PatientContractedServiceRepository(fakeProviderRepo(), jest.fn(async () => ({ opened: 0, closed: 0 })));
const houveUpdate = (c: string[]) => c.some((x) => x.startsWith('UPDATE patient_contracted_services SET'));

describe('PatientContractedServiceRepository.update — REGRA-05 (addressId travado)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it('REGRA-05 recusa: vaga viva → ServiceAddressLockedError LIVE_VACANCY; nenhum UPDATE do serviço', async () => {
    const { cli, chamadas } = cliente({ vagaViva: true });
    mockConnect.mockResolvedValue(cli);

    const err = await repo().update('svc-1', { addressId: 'addr-B', actorUid: 'u-1' }, NOW).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceAddressLockedError);
    expect(err).toMatchObject({ code: 'SERVICE_ADDRESS_LOCKED', details: { reason: 'LIVE_VACANCY' } });
    expect(houveUpdate(chamadas)).toBe(false);
  });

  it('REGRA-05 recusa: sem vaga viva e com alocação vigente → ALLOCATION', async () => {
    const { cli } = cliente({ alocacoes: 2 });
    mockConnect.mockResolvedValue(cli);

    const err = await repo().update('svc-1', { addressId: 'addr-B', actorUid: 'u-1' }, NOW).catch((e) => e);

    expect(err).toMatchObject({ code: 'SERVICE_ADDRESS_LOCKED', details: { reason: 'ALLOCATION' } });
  });

  it('REGRA-05 recusa: addressId null (≠ atual) com alocação vigente → ALLOCATION', async () => {
    const { cli } = cliente({ alocacoes: 1 });
    mockConnect.mockResolvedValue(cli);

    const err = await repo().update('svc-1', { addressId: null, actorUid: 'u-1' }, NOW).catch((e) => e);

    expect(err).toMatchObject({ code: 'SERVICE_ADDRESS_LOCKED', details: { reason: 'ALLOCATION' } });
  });

  it('REGRA-05 recusa: address_id atual NULL e addressId novo com vaga viva → LIVE_VACANCY', async () => {
    const { cli } = cliente({ atual: null, vagaViva: true });
    mockConnect.mockResolvedValue(cli);

    const err = await repo().update('svc-1', { addressId: 'addr-B', actorUid: 'u-1' }, NOW).catch((e) => e);

    expect(err).toMatchObject({ code: 'SERVICE_ADDRESS_LOCKED', details: { reason: 'LIVE_VACANCY' } });
  });

  it('REGRA-05 aceita: addressId igual ao atual (o formulário reenvia) — nenhuma query de vaga nem de alocação', async () => {
    const { cli, chamadas } = cliente({ vagaViva: true, alocacoes: 3 });
    mockConnect.mockResolvedValue(cli);

    const out = await repo().update('svc-1', { addressId: 'addr-A', actorUid: 'u-1' }, NOW);

    expect(out).not.toBeNull();
    expect(chamadas.some((c) => c.startsWith('SELECT 1 FROM job_postings'))).toBe(false);
    expect(chamadas.some((c) => c.startsWith('SELECT count(*)::int AS n'))).toBe(false);
  });

  it('REGRA-05 aceita: sem vaga viva nem alocação vigente → UPDATE do serviço', async () => {
    const { cli, chamadas } = cliente({});
    mockConnect.mockResolvedValue(cli);

    const out = await repo().update('svc-1', { addressId: 'addr-B', actorUid: 'u-1' }, NOW);

    expect(out).not.toBeNull();
    expect(houveUpdate(chamadas)).toBe(true);
  });

  it('REGRA-05 aceita: PATCH sem addressId → nenhuma query de endereço', async () => {
    const { cli, chamadas } = cliente({ vagaViva: true, alocacoes: 3 });
    mockConnect.mockResolvedValue(cli);

    const out = await repo().update('svc-1', { careLocation: 'HOME', actorUid: 'u-1' } as never, NOW);

    expect(out).not.toBeNull();
    expect(chamadas.some((c) => c.startsWith('SELECT address_id, country'))).toBe(false);
  });
});
