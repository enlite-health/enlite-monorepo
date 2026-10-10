/**
 * F2 (vaga-le-do-servico-contratado): o PATCH do serviço recusa APAGAR o horário (`null`/`[]`) com vaga viva.
 * Molde: PatientContractedServiceRepository.test.ts (client mockado; SQL real = e2e).
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }) },
}));

import {
  PatientContractedServiceRepository,
  ServiceFieldRequiredByLiveVacancyError,
} from '../PatientContractedServiceRepository';
import type { ContractedServiceProviderRepository } from '../ContractedServiceProviderRepository';

const SERVICE_ROW = {
  id: 'svc-1', patient_id: 'pat-1', service_code: 'AT', professional_profile: null, providers_needed: 2,
  authorized_hours: '20', weekly_hours: '20', care_location: 'HOME', hourly_value: '1500', start_date: null,
  contract_type: null, tax_condition: null, supervision_frequency: null, guard_shift: null,
  provider_age_band: null, address_id: null,
  schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
  active: true, ended_at: null, country: 'AR', created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z',
};

function fakeProviderRepo(): ContractedServiceProviderRepository {
  return { listForService: jest.fn().mockResolvedValue([]) } as unknown as ContractedServiceProviderRepository;
}

function cliente(liveVacancies: Array<{ id: string }>, rowCountDasVagas: number | null = liveVacancies.length) {
  const chamadas: string[] = [];
  const query = jest.fn(async (sql: string) => {
    chamadas.push(sql.replace(/\s+/g, ' ').trim());
    const t = sql.trim();
    if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return { rows: [], rowCount: 0 };
    if (/^SELECT id FROM patient_contracted_services WHERE id = \$1 FOR UPDATE/.test(t)) return { rows: [{ id: 'svc-1' }], rowCount: 1 };
    if (/^SELECT id FROM job_postings/.test(t)) return { rows: liveVacancies, rowCount: rowCountDasVagas };
    if (/^SELECT providers_needed FROM patient_contracted_services/.test(t)) return { rows: [{ providers_needed: SERVICE_ROW.providers_needed }], rowCount: 1 };
    if (/^INSERT INTO vacancy_source_change_notices/.test(t)) return { rows: [{ job_posting_id: 'vac-1' }], rowCount: 1 };
    if (/^UPDATE patient_contracted_services SET/.test(t)) return { rows: [], rowCount: 1 };
    if (/^SELECT \* FROM patient_contracted_services WHERE id/.test(t)) return { rows: [SERVICE_ROW], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

const SLOT = { dayOfWeek: 2, startTime: '09:00', endTime: '13:00' };

describe('PatientContractedServiceRepository.update — refuseClear (F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it.each([
    ['null', null],
    ['[]', []],
  ])('schedule=%s COM vaga viva → ServiceFieldRequiredByLiveVacancyError (422), nenhum UPDATE do serviço, locks serviço→vagas', async (_n, schedule) => {
    const { cli, chamadas } = cliente([{ id: 'vac-1' }]);
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const err = await repo.update('svc-1', { schedule, actorUid: 'u-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceFieldRequiredByLiveVacancyError);
    expect(err).toMatchObject({ code: 'SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY', field: 'schedule', vacancyIds: ['vac-1'] });
    expect(chamadas.some((c) => c.startsWith('UPDATE patient_contracted_services SET'))).toBe(false);
    expect(chamadas.some((c) => c === 'ROLLBACK')).toBe(true);
    const iSvc = chamadas.findIndex((c) => /^SELECT id FROM patient_contracted_services .* FOR UPDATE/.test(c));
    const iJob = chamadas.findIndex((c) => /^SELECT id FROM job_postings .* FOR UPDATE$/.test(c));
    expect(iSvc).toBeGreaterThanOrEqual(0);
    expect(iJob).toBeGreaterThan(iSvc);
    expect(chamadas[iJob]).toContain("NOT IN ('DE_BAJA', 'CLOSED')");
  });

  it('schedule=null SEM vaga viva → 200 (UPDATE roda, devolve o serviço)', async () => {
    const { cli, chamadas } = cliente([]);
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.update('svc-1', { schedule: null, actorUid: 'u-1' });
    expect(out).not.toBeNull();
    expect(chamadas.some((c) => c.startsWith('UPDATE patient_contracted_services SET'))).toBe(true);
  });

  it('MUDAR o horário (não apagar) COM vaga viva → 200 e nem consulta vagas', async () => {
    const { cli, chamadas } = cliente([{ id: 'vac-1' }]);
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.update('svc-1', { schedule: [SLOT], actorUid: 'u-1' });
    expect(out).not.toBeNull();
    expect(chamadas.some((c) => c.startsWith('SELECT id FROM job_postings'))).toBe(false);
    expect(chamadas.some((c) => c.startsWith('UPDATE patient_contracted_services SET'))).toBe(true);
  });

  it('rowCount nulo na consulta de vagas → conta por rows.length: COM vaga viva recusa, SEM vaga segue', async () => {
    const viva = cliente([{ id: 'vac-9' }], null);
    mockConnect.mockResolvedValue(viva.cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const err = await repo.update('svc-1', { schedule: [], actorUid: 'u-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceFieldRequiredByLiveVacancyError);
    expect(err).toMatchObject({ field: 'schedule', vacancyIds: ['vac-9'] });
    expect(viva.chamadas.some((c) => c.startsWith('UPDATE patient_contracted_services SET'))).toBe(false);

    const livre = cliente([], null);
    mockConnect.mockResolvedValue(livre.cli);
    const out = await repo.update('svc-1', { schedule: [], actorUid: 'u-1' });
    expect(out).not.toBeNull();
    expect(livre.chamadas.some((c) => c.startsWith('UPDATE patient_contracted_services SET'))).toBe(true);
  });
});

describe('PatientContractedServiceRepository.update — quantidade de prestadores (F5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it.each([
    ['null', null],
    ['0', 0],
  ])('providersNeeded=%s COM vaga viva → 422 com field=providers_needed, nenhum UPDATE do serviço, locks serviço→vagas', async (_n, providersNeeded) => {
    const { cli, chamadas } = cliente([{ id: 'vac-1' }]);
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const err = await repo.update('svc-1', { providersNeeded, actorUid: 'u-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceFieldRequiredByLiveVacancyError);
    expect(err).toMatchObject({ code: 'SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY', field: 'providers_needed', vacancyIds: ['vac-1'] });
    expect(chamadas.some((c) => c.startsWith('UPDATE patient_contracted_services SET'))).toBe(false);
    expect(chamadas.some((c) => c === 'ROLLBACK')).toBe(true);
  });

  it('providersNeeded=null SEM vaga viva → segue (UPDATE roda) e não grava aviso', async () => {
    const { cli, chamadas } = cliente([]);
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.update('svc-1', { providersNeeded: null, actorUid: 'u-1' });
    expect(out).not.toBeNull();
    expect(chamadas.some((c) => c.startsWith('UPDATE patient_contracted_services SET'))).toBe(true);
  });

  it('MUDAR a quantidade (2 → 3) COM vaga viva → 200, não consulta a recusa e grava o aviso `providers_needed`', async () => {
    const { cli, chamadas } = cliente([{ id: 'vac-1' }]);
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.update('svc-1', { providersNeeded: 3, actorUid: 'u-1' });
    expect(out).not.toBeNull();
    expect(chamadas.some((c) => c.startsWith('SELECT id FROM job_postings'))).toBe(false);
    const avisos = (cli.query as jest.Mock).mock.calls.filter((c) => /^INSERT INTO vacancy_source_change_notices/.test(String(c[0]).trim()));
    expect(avisos).toHaveLength(1);
    expect(avisos[0][1]).toEqual(['svc-1', 'providers_needed']);
  });

  it('MESMA quantidade (2 → 2) ou PATCH sem a quantidade → 0 avisos', async () => {
    const igual = cliente([{ id: 'vac-1' }]);
    mockConnect.mockResolvedValue(igual.cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.update('svc-1', { providersNeeded: 2, actorUid: 'u-1' });
    expect(igual.chamadas.some((c) => c.startsWith('INSERT INTO vacancy_source_change_notices'))).toBe(false);

    const semCampo = cliente([{ id: 'vac-1' }]);
    mockConnect.mockResolvedValue(semCampo.cli);
    await repo.update('svc-1', { weeklyHours: 10, actorUid: 'u-1' });
    expect(semCampo.chamadas.some((c) => c.startsWith('INSERT INTO vacancy_source_change_notices'))).toBe(false);
    expect(semCampo.chamadas.some((c) => c.startsWith('SELECT providers_needed FROM'))).toBe(false);
  });
});
