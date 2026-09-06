/**
 * PatientContractedServiceRepository — o serviço contratado como entidade (migration 319,
 * spec 013). Molde: InsuranceProviderRepository.test.ts (pool/client mockados; a prova de que
 * o SQL real funciona é o e2e `tests/e2e/patient-contracted-services.e2e.test.ts`).
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }) },
}));

import { PatientContractedServiceRepository, AddressNotOfPatientError } from '../PatientContractedServiceRepository';
import { DeviceTypeUnknownError } from '../PatientDeviceTypeRepository';
import type { ContractedServiceProviderRepository } from '../ContractedServiceProviderRepository';

const SERVICE_ROW = {
  id: 'svc-1',
  patient_id: 'pat-1',
  service_code: 'AT',
  professional_profile: null,
  providers_needed: 2,
  authorized_hours: '20',
  weekly_hours: '20',
  care_location: 'HOME',
  hourly_value: '1500',
  version: null,
  start_date: null,
  contract_type: null,
  tax_condition: null,
  supervision_frequency: null,
  guard_shift: null,
  provider_age_band: null,
  address_id: null,
  schedule: null,
  active: true,
  ended_at: null,
  country: 'AR',
  created_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
};

function fakeProviderRepo(): ContractedServiceProviderRepository {
  return { listForService: jest.fn().mockResolvedValue([]) } as unknown as ContractedServiceProviderRepository;
}

function cliente(responses: Record<string, unknown> = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO patient_contracted_services/.test(sql)) return { rows: [{ id: 'svc-1' }], rowCount: 1 };
    if (/^SELECT \* FROM patient_contracted_services WHERE id/.test(sql)) return { rows: [responses.service ?? SERVICE_ROW], rowCount: 1 };
    if (/^SELECT code FROM device_types WHERE active/.test(sql)) return { rows: [{ code: 'HOME' }, { code: 'SCHOOL' }], rowCount: 2 };
    if (/^DELETE FROM contracted_service_devices/.test(sql)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO contracted_service_devices/.test(sql)) return { rows: [], rowCount: 0 };
    if (/^UPDATE patient_contracted_services SET/.test(sql)) return { rows: [], rowCount: responses.updateRowCount ?? 1 };
    if (/csd\.device_type/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

describe('PatientContractedServiceRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // decorate() sempre relê por this.pool (mockPoolQuery), mesmo quando create/update usam
    // um client de transação separado (mockConnect) para o resto — default seguro, sobrescrito
    // por teste quando a asserção precisa da sequência exata de chamadas.
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it('create: INSERT com colunas condicionais + country explícito, devolve o serviço decorado, COMMIT', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.create({
      patientId: 'pat-1',
      serviceCode: 'AT',
      providersNeeded: 2,
      weeklyHours: 20,
      careLocation: 'HOME',
      hourlyValue: 1500,
      country: 'AR',
      deviceTypeCodes: ['HOME'],
      actorUid: 'uid-1',
    });
    expect(out.id).toBe('svc-1');
    expect(out.serviceCode).toBe('AT');
    expect(out.deviceTypes).toEqual([]); // a query de devices está mockada vazia neste teste
    const ins = chamadas.find((c) => /^INSERT INTO patient_contracted_services/.test(c.sql));
    expect(ins?.sql).toContain('patient_id');
    expect(ins?.sql).toContain('country');
    expect(ins?.params).toContain('pat-1');
    expect(ins?.params).toContain('AR');
    expect(chamadas[0].sql).toBe('BEGIN');
    expect(chamadas[chamadas.length - 1].sql).toBe('COMMIT');
  });

  it('create: sem country (omitido) → coluna country NÃO entra no INSERT (o trigger deriva)', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.create({ patientId: 'pat-1', serviceCode: 'AT', actorUid: 'uid-1' });
    const ins = chamadas.find((c) => /^INSERT INTO patient_contracted_services/.test(c.sql));
    expect(ins?.sql).not.toContain('country');
  });

  it('create: device code fora do catálogo → DeviceTypeUnknownError, ROLLBACK', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await expect(
      repo.create({ patientId: 'pat-1', serviceCode: 'AT', deviceTypeCodes: ['NAO_EXISTE'], actorUid: 'uid-1' }),
    ).rejects.toBeInstanceOf(DeviceTypeUnknownError);
    expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
  });

  // ── Migration 330: endereço (ponteiro) e horário ─────────────────────────────────────────
  it('create: schedule vai como JSON string (array JS viraria ARRAY Postgres, que o JSONB recusa); addressId vai cru', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const schedule = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
    await repo.create({ patientId: 'pat-1', serviceCode: 'AT', addressId: 'addr-1', schedule, actorUid: 'uid-1' });
    const ins = chamadas.find((c) => /^INSERT INTO patient_contracted_services/.test(c.sql))!;
    expect(ins.sql).toMatch(/address_id/);
    expect(ins.sql).toMatch(/schedule/);
    expect(ins.params).toContain('addr-1');
    expect(ins.params).toContain(JSON.stringify(schedule));
    expect(ins.params).not.toContainEqual(schedule);
  });

  it('update: schedule:null e addressId:null vão como null (limpar é caminho válido), sem stringify', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.update('svc-1', { schedule: null, addressId: null, actorUid: 'uid-1' });
    const upd = chamadas.find((c) => /^UPDATE patient_contracted_services SET/.test(c.sql))!;
    expect(upd.sql).toMatch(/address_id = \$2/);
    expect(upd.sql).toMatch(/schedule = \$3/);
    expect(upd.params.slice(1, 3)).toEqual([null, null]);
  });

  it('create/update: FK composta violada (address_id de OUTRO paciente, 23503 em pcs_address_same_patient_fk) → AddressNotOfPatientError, ROLLBACK', async () => {
    const fk = Object.assign(new Error('violates foreign key'), { code: '23503', constraint: 'pcs_address_same_patient_fk' });
    for (const op of ['create', 'update'] as const) {
      const { cli, chamadas } = cliente();
      (cli.query as jest.Mock).mockImplementation(async (sql: string, params: unknown[] = []) => {
        chamadas.push({ sql, params });
        if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(sql.trim())) return { rows: [], rowCount: 0 };
        if (/^(INSERT INTO|UPDATE) patient_contracted_services/.test(sql)) throw fk;
        return { rows: [], rowCount: 0 };
      });
      mockConnect.mockResolvedValue(cli);
      const repo = new PatientContractedServiceRepository(fakeProviderRepo());
      const run = op === 'create'
        ? repo.create({ patientId: 'pat-1', serviceCode: 'AT', addressId: 'addr-alheio', actorUid: 'uid-1' })
        : repo.update('svc-1', { addressId: 'addr-alheio', actorUid: 'uid-1' });
      const err = await run.catch((e) => e);
      expect(err).toBeInstanceOf(AddressNotOfPatientError);
      expect((err as AddressNotOfPatientError).code).toBe('ADDRESS_NOT_OF_PATIENT');
      expect((err as AddressNotOfPatientError).addressId).toBe('addr-alheio');
      expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
    }
  });

  it('update: 23503 de OUTRA constraint (não é a FK do endereço) → propaga o erro original', async () => {
    const other = Object.assign(new Error('other fk'), { code: '23503', constraint: 'outra_fk' });
    const { cli } = cliente();
    (cli.query as jest.Mock).mockImplementation(async (sql: string) => {
      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(sql.trim())) return { rows: [], rowCount: 0 };
      if (/^UPDATE patient_contracted_services/.test(sql)) throw other;
      return { rows: [], rowCount: 0 };
    });
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await expect(repo.update('svc-1', { addressId: 'x', actorUid: 'uid-1' })).rejects.toBe(other);
  });

  it('create: erro genérico → propaga, ROLLBACK', async () => {
    const { cli } = cliente();
    (cli.query as jest.Mock).mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })) // BEGIN
      .mockImplementationOnce(async () => { throw new Error('boom'); });
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await expect(repo.create({ patientId: 'pat-1', serviceCode: 'AT', actorUid: 'uid-1' })).rejects.toThrow('boom');
  });

  it('update: Merge Patch parcial — só os campos presentes entram no SET', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.update('svc-1', { weeklyHours: 25, actorUid: 'uid-2' });
    expect(out?.id).toBe('svc-1');
    const upd = chamadas.find((c) => /^UPDATE patient_contracted_services SET/.test(c.sql));
    expect(upd?.sql).toContain('weekly_hours');
    expect(upd?.sql).not.toContain('providers_needed');
    expect(upd?.sql).toContain('updated_by');
  });

  it('update: active:false grava ended_at = NOW()', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.update('svc-1', { active: false, actorUid: 'uid-2' });
    const upd = chamadas.find((c) => /^UPDATE patient_contracted_services SET/.test(c.sql));
    expect(upd?.sql).toContain('ended_at = NOW()');
  });

  it('update: active:true grava ended_at = NULL', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.update('svc-1', { active: true, actorUid: 'uid-2' });
    const upd = chamadas.find((c) => /^UPDATE patient_contracted_services SET/.test(c.sql));
    expect(upd?.sql).toContain('ended_at = NULL');
  });

  it('update: deviceTypeCodes presente substitui o conjunto (mesmo sem outros campos)', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.update('svc-1', { deviceTypeCodes: ['HOME', 'SCHOOL'], actorUid: 'uid-2' });
    expect(chamadas.some((c) => /^DELETE FROM contracted_service_devices/.test(c.sql))).toBe(true);
    expect(chamadas.filter((c) => /^INSERT INTO contracted_service_devices/.test(c.sql))).toHaveLength(2);
  });

  it('update: rowCount 0 → ROLLBACK, devolve null (id inexistente)', async () => {
    const { cli } = cliente({ updateRowCount: 0 });
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.update('svc-inexistente', { weeklyHours: 1, actorUid: 'uid-2' });
    expect(out).toBeNull();
  });

  it('update: nada presente além de actorUid → nenhum UPDATE de coluna (sets vazio), só relê', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.update('svc-1', { actorUid: 'uid-2' });
    expect(chamadas.some((c) => /^UPDATE patient_contracted_services SET/.test(c.sql))).toBe(false);
  });

  it('listForPatient: mapeia numéricos (Number) e delega devices/providers por serviço', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [SERVICE_ROW] }); // listForPatient main query
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // devices (decorate)
    const providerRepo = fakeProviderRepo();
    const repo = new PatientContractedServiceRepository(providerRepo);
    const out = await repo.listForPatient('pat-1');
    expect(out).toHaveLength(1);
    expect(out[0].weeklyHours).toBe(20);
    expect(out[0].hourlyValue).toBe(1500);
    expect(providerRepo.listForService).toHaveBeenCalledWith('svc-1');
  });

  it('findById: sem linha → null', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    expect(await repo.findById('nope')).toBeNull();
  });

  it('findById: com linha → decorado', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [SERVICE_ROW] }); // main
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // devices (decorate)
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.findById('svc-1');
    expect(out?.id).toBe('svc-1');
  });

  it('create: providerAgeBand entra no INSERT (spec 015, US-A6.1) e volta decorado no shape', async () => {
    const { cli, chamadas } = cliente({ service: { ...SERVICE_ROW, provider_age_band: 'AGE_30_45' } });
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.create({ patientId: 'pat-1', serviceCode: 'AT', providerAgeBand: 'AGE_30_45', actorUid: 'uid-1' });
    const ins = chamadas.find((c) => /^INSERT INTO patient_contracted_services/.test(c.sql));
    expect(ins?.sql).toContain('provider_age_band');
    expect(ins?.params).toContain('AGE_30_45');
    expect(out.providerAgeBand).toBe('AGE_30_45');
  });

  it('update: providerAgeBand presente entra no SET (Merge Patch)', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.update('svc-1', { providerAgeBand: 'ANY', actorUid: 'uid-2' });
    const upd = chamadas.find((c) => /^UPDATE patient_contracted_services SET/.test(c.sql));
    expect(upd?.sql).toContain('provider_age_band');
  });

  it('listForPatient: providerAgeBand nulo permanece null (serviço pré-existente à migration 322)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [SERVICE_ROW] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.listForPatient('pat-1');
    expect(out[0].providerAgeBand).toBeNull();
  });

  it('listForPatient: devices com linhas → deviceTypes mapeia csd.device_type (QA-caça A6 #2: linha antes descoberta)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [SERVICE_ROW] }); // main
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ device_type: 'HOME' }, { device_type: 'SCHOOL' }] }); // devices (decorate)
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const [svc] = await repo.listForPatient('pat-1');
    expect(svc.deviceTypes).toEqual(['HOME', 'SCHOOL']);
  });

  // ── QA-caça A6 #2: ramificações que ficaram sem teste desde o bloco C (D200: 100 % no arquivo tocado) ──
  function sobrescreve(cli: { query: jest.Mock }, regex: RegExp, impl: () => Promise<unknown>): void {
    const original = cli.query.getMockImplementation()!;
    cli.query.mockImplementation(async (sql: string, params: unknown[] = []) => (regex.test(sql) ? impl() : original(sql, params)));
  }

  it('update: rowCount null (driver sem contagem) conta como 0 → ROLLBACK, null', async () => {
    const { cli, chamadas } = cliente();
    sobrescreve(cli, /^UPDATE patient_contracted_services SET/, async () => ({ rows: [], rowCount: null }));
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    expect(await repo.update('svc-1', { weeklyHours: 1, actorUid: 'uid-2' })).toBeNull();
    expect(chamadas.some((c) => c.sql.trim() === 'ROLLBACK')).toBe(true);
  });

  it('update: linha some entre o UPDATE e a releitura → null (sem decorar)', async () => {
    const { cli } = cliente();
    sobrescreve(cli, /^SELECT \* FROM patient_contracted_services WHERE id/, async () => ({ rows: [], rowCount: 0 }));
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    expect(await repo.update('svc-1', { weeklyHours: 1, actorUid: 'uid-2' })).toBeNull();
  });

  it('update: erro genérico → ROLLBACK e propaga', async () => {
    const { cli, chamadas } = cliente();
    sobrescreve(cli, /^UPDATE patient_contracted_services SET/, async () => { throw new Error('boom-update'); });
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await expect(repo.update('svc-1', { weeklyHours: 1, actorUid: 'uid-2' })).rejects.toThrow('boom-update');
    expect(chamadas.some((c) => c.sql.trim() === 'ROLLBACK')).toBe(true);
    expect(cli.release).toHaveBeenCalled();
  });

  it('construtor padrão (providerRepo real) e pool memoizado entre chamadas', async () => {
    const repo = new PatientContractedServiceRepository();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    expect(await repo.findById('svc-x')).toBeNull();
    expect(await repo.findById('svc-y')).toBeNull();
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it('listForPatient: authorizedHours/weeklyHours/hourlyValue nulos permanecem null (não 0)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...SERVICE_ROW, authorized_hours: null, weekly_hours: null, hourly_value: null }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    const out = await repo.listForPatient('pat-1');
    expect(out[0]).toMatchObject({ authorizedHours: null, weeklyHours: null, hourlyValue: null });
  });

  it('update: erro genérico durante o UPDATE → propaga, ROLLBACK, client liberado', async () => {
    const { cli } = cliente();
    (cli.query as jest.Mock)
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })) // BEGIN
      .mockImplementationOnce(async () => { throw new Error('boom-update'); }); // UPDATE
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await expect(repo.update('svc-1', { weeklyHours: 1, actorUid: 'uid-2' })).rejects.toThrow('boom-update');
    expect(cli.release).toHaveBeenCalled();
  });

  it('update: deviceTypeCodes vazio ([]) → replaceDevices roda mas validateDeviceCodes retorna cedo (nenhum código a validar)', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientContractedServiceRepository(fakeProviderRepo());
    await repo.update('svc-1', { deviceTypeCodes: [], actorUid: 'uid-2' });
    expect(chamadas.some((c) => /^SELECT code FROM device_types WHERE active/.test(c.sql))).toBe(false);
    expect(chamadas.some((c) => /^DELETE FROM contracted_service_devices/.test(c.sql))).toBe(true);
  });
});
