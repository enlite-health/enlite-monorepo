/**
 * ActivateRecruitmentUseCase — spec 018, PR-6, ADR-5, `contracts/activation.md`.
 *
 * `inPatientTransaction` mockado (mesmo molde de `AdminPatientContactRowsController.test.ts`):
 * a prova end-to-end (SQL real, RLS, `buildInsertQuery` real) é o e2e
 * `tests/e2e/patient-status-completeness.e2e.test.ts` (12/13). Aqui cobrimos os ramos de
 * decisão da orquestração: 404 (paciente/serviço), 409 (vaga viva), 422 (gate), 201 feliz com
 * e sem virada de status.
 */
const mockInPatientTransaction = jest.fn((fn: (client: unknown) => unknown) => fn({ marker: 'client' }));
jest.mock('../patientTransaction', () => ({
  inPatientTransaction: (fn: (client: unknown) => unknown) => mockInPatientTransaction(fn),
}));

const mockBuildInsertParams = jest.fn((p: Record<string, unknown>) => [p]);
jest.mock('@modules/matching', () => ({
  buildInsertQuery: jest.fn(() => 'INSERT INTO job_postings (...) VALUES (...) RETURNING *'),
  buildInsertParams: (p: Record<string, unknown>) => mockBuildInsertParams(p),
}));

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  ActivateRecruitmentUseCase,
  PatientNotFoundForRecruitmentError,
  ServiceNotFoundForRecruitmentError,
  ServiceAlreadyRecruitingError,
  RecruitmentNotReadyError,
} from '../ActivateRecruitmentUseCase';

const PATIENT_ID = 'p-1';
const SERVICE_ID = 's-1';

interface DispatchOpts {
  patientRow?: {
    id: string;
    status: string;
    case_number: number | null;
    insurance_informed?: string | null;
  } | null;
  serviceRow?: {
    id: string;
    providers_needed?: number | null;
    provider_age_band?: string | null;
    schedule?: unknown;
    live_address_id?: string | null;
  } | null;
  liveVacancyId?: string | null;
  vacancyNumber?: number;
  insertedId?: string;
  /** T019 — força o INSERT do audit (dentro do SAVEPOINT) a rejeitar. */
  auditInsertThrows?: boolean;
}

function makeClient(opts: DispatchOpts) {
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    // T018/T019 — SAVEPOINT do `logEventSafe` (best-effort): SAVEPOINT/RELEASE/
    // ROLLBACK sempre "sucedem" no mock; só o INSERT do audit pode ser
    // instruído a falhar (auditInsertThrows), para provar que o falho NÃO
    // propaga e a vaga continua sendo criada.
    if (/^SAVEPOINT /.test(sql) || /^RELEASE SAVEPOINT /.test(sql) || /^ROLLBACK TO SAVEPOINT /.test(sql)) {
      return {};
    }
    if (sql.includes('INSERT INTO job_posting_audit_log')) {
      if (opts.auditInsertThrows) throw new Error('audit insert falhou (simulado, T019)');
      return { rows: [] };
    }
    if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
      if (!opts.patientRow) return { rowCount: 0, rows: [] };
      const { id, status, case_number, insurance_informed } = opts.patientRow;
      return { rowCount: 1, rows: [{ id, status, case_number, insurance_informed: insurance_informed ?? null }] };
    }
    if (sql.includes('FROM patient_contracted_services pcs') && sql.includes('FOR UPDATE OF pcs')) {
      if (!opts.serviceRow) return { rowCount: 0, rows: [] };
      const { id, providers_needed = null, provider_age_band = null, schedule = null, live_address_id = null } = opts.serviceRow;
      return { rowCount: 1, rows: [{ id, providers_needed, provider_age_band, schedule, live_address_id }] };
    }
    if (sql.includes('FROM job_postings WHERE contracted_service_id')) {
      return opts.liveVacancyId
        ? { rowCount: 1, rows: [{ id: opts.liveVacancyId }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('nextval')) {
      return { rows: [{ vn: String(opts.vacancyNumber ?? 100) }] };
    }
    if (sql === "SELECT set_config('app.change_source', $1, true)") {
      return {};
    }
    if (sql.includes('UPDATE patients SET status')) {
      return {};
    }
    if (sql.startsWith('INSERT INTO job_postings')) {
      return { rows: [{ id: opts.insertedId ?? 'vac-1' }] };
    }
    throw new Error(`unexpected query in test: ${sql}`);
  });
  return { query };
}

function run(opts: DispatchOpts) {
  const client = makeClient(opts);
  mockInPatientTransaction.mockImplementationOnce((fn: (c: unknown) => unknown) => fn(client));
  const useCase = new ActivateRecruitmentUseCase();
  return { promise: useCase.execute(PATIENT_ID, SERVICE_ID), client };
}

const READY_SERVICE = {
  id: SERVICE_ID,
  providers_needed: 2,
  provider_age_band: 'AGE_20_30',
  schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
  live_address_id: 'addr-1',
};

describe('ActivateRecruitmentUseCase', () => {
  beforeEach(() => jest.clearAllMocks());

  it('201 feliz — paciente no funil (ADMISSION): cria a vaga e move para SEARCHING (statusChanged:true)', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: 'Particular' },
      serviceRow: READY_SERVICE,
      vacancyNumber: 500,
      insertedId: 'vac-42',
    });
    const result = await promise;
    expect(result).toEqual({ vacancyId: 'vac-42', patientStatus: 'SEARCHING', statusChanged: true });
    expect(mockBuildInsertParams).toHaveBeenCalledWith(
      expect.objectContaining({
        patient_id: PATIENT_ID,
        contracted_service_id: SERVICE_ID,
        patient_address_id: 'addr-1',
        providers_needed: 2,
        schedule: READY_SERVICE.schedule,
        age_range_min: 20,
        age_range_max: 29,
        is_test: false,
      }),
    );
  });

  it('201 feliz — paciente já ACTIVE (2º serviço): cria a vaga SEM mudar o status (statusChanged:false)', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ACTIVE', case_number: 100, insurance_informed: 'Particular' },
      serviceRow: READY_SERVICE,
    });
    const result = await promise;
    expect(result).toEqual({ vacancyId: 'vac-1', patientStatus: 'ACTIVE', statusChanged: false });
  });

  it('SOLICITANTE também é funil: vira SEARCHING (SUP-20 — ativa sem admissão nenhuma)', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'SOLICITANTE', case_number: 100, insurance_informed: 'Particular' },
      serviceRow: READY_SERVICE,
    });
    const result = await promise;
    expect(result.patientStatus).toBe('SEARCHING');
    expect(result.statusChanged).toBe(true);
  });

  it('404 — paciente inexistente (ou soft-deletado)', async () => {
    const { promise } = run({ patientRow: null, serviceRow: READY_SERVICE });
    await expect(promise).rejects.toBeInstanceOf(PatientNotFoundForRecruitmentError);
  });

  it('404 — serviço inexistente, de OUTRO paciente, ou inativo (a query já filtra active)', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100 },
      serviceRow: null,
    });
    await expect(promise).rejects.toBeInstanceOf(ServiceNotFoundForRecruitmentError);
  });

  it('409 — serviço já tem vaga viva; devolve o vacancyId da vaga existente', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: 'Particular' },
      serviceRow: READY_SERVICE,
      liveVacancyId: 'vac-existente',
    });
    await expect(promise).rejects.toMatchObject({
      constructor: ServiceAlreadyRecruitingError,
      vacancyId: 'vac-existente',
    });
  });

  it('422 — SERVICE_ADDRESS: serviço sem endereço vivo (live_address_id null)', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: 'Particular' },
      serviceRow: { ...READY_SERVICE, live_address_id: null },
    });
    await expect(promise).rejects.toMatchObject({ missing: ['SERVICE_ADDRESS'] });
  });

  it('422 — SERVICE_SCHEDULE: schedule null conta como ausente', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: 'Particular' },
      serviceRow: { ...READY_SERVICE, schedule: null },
    });
    await expect(promise).rejects.toMatchObject({ missing: ['SERVICE_SCHEDULE'] });
  });

  it('422 — SERVICE_SCHEDULE: schedule [] (array vazio) TAMBÉM conta como ausente — não só null', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: 'Particular' },
      serviceRow: { ...READY_SERVICE, schedule: [] },
    });
    await expect(promise).rejects.toMatchObject({ missing: ['SERVICE_SCHEDULE'] });
  });

  it('422 — COVERAGE: placeholder (FR-122) conta como ausente; "Particular" (FR-121) passa', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: '0' },
      serviceRow: READY_SERVICE,
    });
    await expect(promise).rejects.toMatchObject({ missing: ['COVERAGE'] });
  });

  it('422 — os TRÊS códigos juntos, na ordem SERVICE_ADDRESS, SERVICE_SCHEDULE, COVERAGE', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: null },
      serviceRow: { ...READY_SERVICE, live_address_id: null, schedule: null },
    });
    await expect(promise).rejects.toBeInstanceOf(RecruitmentNotReadyError);
    await expect(promise).rejects.toMatchObject({
      missing: ['SERVICE_ADDRESS', 'SERVICE_SCHEDULE', 'COVERAGE'],
      patientId: PATIENT_ID,
      serviceId: SERVICE_ID,
    });
  });

  it('franja etária ausente (provider_age_band null) → age_range null/null (fallback), não estoura', async () => {
    const { promise } = run({
      patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: 'Particular' },
      serviceRow: { ...READY_SERVICE, provider_age_band: null },
    });
    await promise;
    expect(mockBuildInsertParams).toHaveBeenCalledWith(
      expect.objectContaining({ age_range_min: null, age_range_max: null }),
    );
  });

  it('erro inesperado (não é um dos 4 conhecidos) sobe cru — o controller decide o 500', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('DB down')) };
    mockInPatientTransaction.mockImplementationOnce((fn: (c: unknown) => unknown) => fn(client));
    const useCase = new ActivateRecruitmentUseCase();
    await expect(useCase.execute(PATIENT_ID, SERVICE_ID)).rejects.toThrow('DB down');
  });

  it('erro inesperado que NÃO é instância de Error (String(err) no log) — sobe cru do mesmo jeito', async () => {
    const client = { query: jest.fn().mockRejectedValue('rejeição crua') };
    mockInPatientTransaction.mockImplementationOnce((fn: (c: unknown) => unknown) => fn(client));
    const useCase = new ActivateRecruitmentUseCase();
    await expect(useCase.execute(PATIENT_ID, SERVICE_ID)).rejects.toBe('rejeição crua');
  });

  it('rowCount undefined (driver não informa) no SELECT do paciente cai no `?? 0` — 404', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
          return { rowCount: undefined, rows: [] };
        }
        throw new Error(`unexpected: ${sql}`);
      }),
    };
    mockInPatientTransaction.mockImplementationOnce((fn: (c: unknown) => unknown) => fn(client));
    const useCase = new ActivateRecruitmentUseCase();
    await expect(useCase.execute(PATIENT_ID, SERVICE_ID)).rejects.toBeInstanceOf(PatientNotFoundForRecruitmentError);
  });

  it('rowCount undefined no SELECT do serviço cai no `?? 0` — 404', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
          return { rowCount: 1, rows: [{ id: PATIENT_ID, status: 'ADMISSION', case_number: 1, insurance_informed: 'Particular' }] };
        }
        if (sql.includes('FROM patient_contracted_services pcs') && sql.includes('FOR UPDATE OF pcs')) {
          return { rowCount: undefined, rows: [] };
        }
        throw new Error(`unexpected: ${sql}`);
      }),
    };
    mockInPatientTransaction.mockImplementationOnce((fn: (c: unknown) => unknown) => fn(client));
    const useCase = new ActivateRecruitmentUseCase();
    await expect(useCase.execute(PATIENT_ID, SERVICE_ID)).rejects.toBeInstanceOf(ServiceNotFoundForRecruitmentError);
  });

  it('rowCount undefined no SELECT de vaga viva cai no `?? 0` — segue como "sem vaga viva" (não 409)', async () => {
    // Cobre o MESMO ramo de `run({ liveVacancyId: undefined })` (que já devolve `rowCount: 0`
    // explícito), só que com `rowCount: undefined` em vez de `0` — o `?? 0` do código.
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
          return { rowCount: 1, rows: [{ id: PATIENT_ID, status: 'ADMISSION', case_number: 1, insurance_informed: 'Particular' }] };
        }
        if (sql.includes('FROM patient_contracted_services pcs') && sql.includes('FOR UPDATE OF pcs')) {
          return { rowCount: 1, rows: [READY_SERVICE] };
        }
        if (sql.includes('FROM job_postings WHERE contracted_service_id')) {
          return { rowCount: undefined, rows: [] };
        }
        if (sql.includes('nextval')) return { rows: [{ vn: '1' }] };
        if (sql === "SELECT set_config('app.change_source', $1, true)") return {};
        if (sql.includes('UPDATE patients SET status')) return {};
        if (sql.startsWith('INSERT INTO job_postings')) return { rows: [{ id: 'vac-x' }] };
        throw new Error(`unexpected: ${sql}`);
      }),
    };
    mockInPatientTransaction.mockImplementationOnce((fn: (c: unknown) => unknown) => fn(client));
    const useCase = new ActivateRecruitmentUseCase();
    await expect(useCase.execute(PATIENT_ID, SERVICE_ID)).resolves.toMatchObject({ vacancyId: 'vac-x' });
  });

  // ── T019 (spec 027, US2) — trilha de auditoria da vaga criada pelo SISTEMA ──

  describe('audit — vaga criada pelo sistema (T018)', () => {
    it('audit. INSERT do audit log leva event_type=CREATED, actor_type=SYSTEM, actor_label=activate_recruitment', async () => {
      const { promise, client } = run({
        patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: 'Particular' },
        serviceRow: READY_SERVICE,
        vacancyNumber: 500,
        insertedId: 'vac-42',
      });
      const result = await promise;
      expect(result.vacancyId).toBe('vac-42');

      const auditCall = (client.query as jest.Mock).mock.calls.find(
        ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO job_posting_audit_log'),
      );
      expect(auditCall).toBeDefined();
      const [, values] = auditCall as [string, unknown[]];
      // Ordem de BaseAuditLogRepository.logEvent: [entityId, eventType, fieldName,
      // changesJSON, actorUserId, actorType, actorLabel, traceId].
      expect(values[0]).toBe('vac-42');       // job_posting_id
      expect(values[1]).toBe('CREATED');      // event_type
      expect(values[4]).toBeNull();           // actor_user_id
      expect(values[5]).toBe('SYSTEM');       // actor_type
      expect(values[6]).toBe('activate_recruitment'); // actor_label
    });

    it('audit throws. auditoria lança dentro do SAVEPOINT → a vaga é criada MESMO ASSIM (best-effort, nunca derruba)', async () => {
      const { promise } = run({
        patientRow: { id: PATIENT_ID, status: 'ADMISSION', case_number: 100, insurance_informed: 'Particular' },
        serviceRow: READY_SERVICE,
        vacancyNumber: 501,
        insertedId: 'vac-43',
        auditInsertThrows: true,
      });

      const result = await promise;
      expect(result).toEqual({ vacancyId: 'vac-43', patientStatus: 'SEARCHING', statusChanged: true });
    });
  });
});
