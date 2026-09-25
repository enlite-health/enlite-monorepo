/**
 * AnaCareHoursService — fonte STUB (implementa a porta em memória, sem tocar o adapter falso de
 * verdade) + `ShiftHoursValidationRepository` MOCKADO (jest) + KMS real em modo passthrough
 * (`NODE_ENV=test`, ver `KMSEncryptionService`) — prova o round-trip de cifra/decifra sem rede.
 */
import { AnaCareHoursService, isValidMonth, periodMonthDate } from '../AnaCareHoursService';
import { ShiftHoursValidationRepository, ShiftAlreadyValidatedError, type ValidationRow } from '../../infrastructure/ShiftHoursValidationRepository';
import { WorkerLinkRepository, type WorkerLinkRow } from '../../infrastructure/WorkerLinkRepository';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { AnaCareHoursServiceError, VALIDATE_BATCH_MAX_SHIFTS } from '../../domain/AnaCareShift';
import type { AnaCareRetratoSourceStatus, AnaCareShiftsSource, SourceShiftDTO } from '../../domain/AnaCareShiftsSource';
import type { PatientMonthSyncRepository, SyncRunConclusion, SyncRunRepository } from '../../domain/AnaCareHoursSyncPorts';
import type { AnaCarePatientMonthAggregate, AnaCarePatientMonthProviderAggregate } from '../../domain/AnaCarePatientMonth';
import type { AnaCarePatientDocumentRecord, IAnaCarePatientDocumentRepository, AxonicoLancamentoSentRecord, IAxonicoLancamentoRepository } from '@modules/integration';

// change `axonico-envio-rastreavel` (24/09/2026): sem este mock, o novo parâmetro default
// (`new AxonicoLancamentoRepository()`, 8º positional) tentaria abrir o Pool de verdade em TODO
// teste de `getPatientMonth` que lê `documentNumber` (vários já fazem, ver describe "item 4") sem
// injetar `lancamentoRepository` — mesmo racional do mock de `WorkerLinkRepository`/
// `AnaCareSyncRunRepository` abaixo. Default devolve `[]` (nenhum lançamento no mês), que é
// exatamente o comportamento ANTERIOR a esta fase (`axonico` nunca aparecia).
jest.mock('@modules/integration', () => {
  const actual = jest.requireActual('@modules/integration');
  return {
    ...actual,
    AxonicoLancamentoRepository: jest.fn().mockImplementation(() => ({
      findSentByDocumentAndMonth: jest.fn().mockResolvedValue([]),
    })),
  };
});

jest.mock('../../infrastructure/ShiftHoursValidationRepository', () => {
  const actual = jest.requireActual('../../infrastructure/ShiftHoursValidationRepository');
  return {
    ...actual,
    ShiftHoursValidationRepository: jest.fn(),
  };
});

// F2 (migration 457): sem este mock, o novo parâmetro default (`new AnaCareSyncRunRepository()`)
// tentaria abrir o Pool de verdade em TODO teste de `getMonthSnapshot` que não injeta
// `syncRunRepository` — mesmo racional do mock de `WorkerLinkRepository` abaixo (D349). Default
// devolve `status:'done'` com `reservationsTotal===reservationsDone===0` (0 não é < 0) — préserva
// o comportamento ANTERIOR a esta fase para os testes que não são sobre a conclusão em si (a
// precedência cai direto em stale/fresco, exatamente como antes de existir `syncRunRepository`).
jest.mock('../../infrastructure/AnaCareSyncRunRepository', () => ({
  AnaCareSyncRunRepository: jest.fn().mockImplementation(() => ({
    getConclusion: jest.fn().mockResolvedValue({ status: 'done', reservationsTotal: 0, reservationsDone: 0 }),
    startNewRun: jest.fn(),
    getRunStartedAt: jest.fn(),
    recordProgress: jest.fn(),
  })),
}));

// D349: sem este mock, o 4º parâmetro default (`new WorkerLinkRepository()`) tentaria abrir o
// Pool de verdade (`DatabaseConnection.getInstance()`) em todo teste que não injeta workerLinks —
// default aqui devolve Map vazia (nenhum vínculo), o MESMO comportamento de antes da D349.
jest.mock('../../infrastructure/WorkerLinkRepository', () => ({
  WorkerLinkRepository: jest.fn().mockImplementation(() => ({
    findByAnaCareIds: jest.fn().mockResolvedValue(new Map()),
  })),
}));

function mockWorkerLinks(rows: ReadonlyMap<string, WorkerLinkRow> = new Map()): jest.Mocked<WorkerLinkRepository> {
  return { findByAnaCareIds: jest.fn().mockResolvedValue(rows) } as unknown as jest.Mocked<WorkerLinkRepository>;
}

const SHIFT_A: SourceShiftDTO = {
  sourceShiftId: 'shift-a',
  anaCarePatientId: 'AC-PAT-0',
  anaCareNurseId: 'AC-NURSE-0',
  date: '2026-09-10',
  scheduledStart: '2026-09-10T08:00:00.000Z',
  scheduledEnd: '2026-09-10T12:00:00.000Z',
  actualStart: '2026-09-10T08:00:00.000Z',
  actualEnd: '2026-09-10T12:00:00.000Z',
  checkinSource: 'app',
  isFinalized: true,
  // Item 1 (17/09): nome vem da FONTE (payload do turno) — nunca de `workers`/KMS.
  patientFirstName: 'Lucía',
  patientLastName: 'Fernández QA',
  nurseFirstName: 'Rocío',
  nurseLastName: 'García QA',
  // Item 4 (18/09): documento do paciente — PII, gated no controller (patient_identity:read).
  patientDocumentType: 'DNI',
  patientDocumentNumber: '30999888',
};

const SHIFT_SEM_CHECKIN: SourceShiftDTO = {
  ...SHIFT_A,
  sourceShiftId: 'shift-b',
  actualStart: null,
  actualEnd: null,
  checkinSource: null,
  isFinalized: false,
};

class StubSource implements AnaCareShiftsSource {
  constructor(
    private readonly shifts: SourceShiftDTO[] = [SHIFT_A, SHIFT_SEM_CHECKIN],
    // Conserto de conformidade (15/09): retrato injetável — SÓ pra este teste unitário simular
    // stale/disjuntor aberto. O adapter falso real (`FakeAnaCareShiftsSource`) continua
    // hardcoded `{ stale: false, circuitBreakerOpen: false }`, sem staleness de verdade (fase 1).
    private readonly retrato: AnaCareRetratoSourceStatus = { stale: false, circuitBreakerOpen: false },
  ) {}
  async listShifts(params: { month: string; patientId?: string }): Promise<{ shifts: SourceShiftDTO[]; skipped: { noProvider: number; noPatient: number } }> {
    const shifts = this.shifts.filter((s) => !params.patientId || s.anaCarePatientId === params.patientId);
    return { shifts, skipped: { noProvider: 0, noPatient: 0 } };
  }
  async getShift(id: string): Promise<SourceShiftDTO | null> {
    return this.shifts.find((s) => s.sourceShiftId === id) ?? null;
  }
  async getRetratoStatus(): Promise<AnaCareRetratoSourceStatus> {
    return this.retrato;
  }
}

function mockRepo(overrides: Partial<jest.Mocked<ShiftHoursValidationRepository>> = {}): jest.Mocked<ShiftHoursValidationRepository> {
  return {
    getByShiftIds: jest.fn().mockResolvedValue(new Map()),
    getOne: jest.fn().mockResolvedValue(null),
    validate: jest.fn().mockResolvedValue(undefined),
    contest: jest.fn().mockResolvedValue(undefined),
    // F6.2: contagem de validated/contested por paciente (GROUP BY) — vazio por default (nenhuma validação).
    getStatusCountsByMonth: jest.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as unknown as jest.Mocked<ShiftHoursValidationRepository>;
}

/**
 * F6.2 (D361/Adendo 17/09): STUB do retrato AGREGADO (`PatientMonthSyncRepository`) — a LISTA
 * (`getMonthSnapshot`) lê exclusivamente daqui a partir desta fase, nunca mais do array de turnos.
 * `aggregates=[]` por default simula "retrato agregado nunca construído".
 */
class StubPatientMonthRepository implements PatientMonthSyncRepository {
  constructor(
    private readonly aggregates: AnaCarePatientMonthAggregate[] = [],
    private readonly providers: AnaCarePatientMonthProviderAggregate[] = [],
    private readonly lastFetchedAt: string | null = '2026-09-15T00:00:00.000Z',
  ) {}
  async upsertMany(): Promise<{ written: number }> {
    return { written: 0 };
  }
  async recomputeFromShifts(): Promise<{ written: number }> {
    return { written: 0 };
  }
  async upsertReplacingForRun(): Promise<{ written: number }> {
    return { written: 0 };
  }
  async listByMonth(): Promise<AnaCarePatientMonthAggregate[]> {
    return this.aggregates;
  }
  async listProvidersByMonth(): Promise<AnaCarePatientMonthProviderAggregate[]> {
    return this.providers;
  }
  async getSnapshotFreshness(): Promise<{ shifts: number; lastFetchedAt: string | null }> {
    return { shifts: this.aggregates.length, lastFetchedAt: this.aggregates.length > 0 ? this.lastFetchedAt : null };
  }
}

const AGGREGATE_PAT_0: AnaCarePatientMonthAggregate = {
  anaCarePatientId: 'AC-PAT-0',
  patientFirstName: 'Lucía',
  patientLastName: 'Fernández QA',
  providersCount: 1,
  shiftsCount: 2,
  hoursActualSum: 11.8,
  hoursScheduledSumMissingActual: 6,
  originSinCheckin: 1,
  originWebAdmin: 0,
  originApp: 1,
};

const PROVIDER_PAT_0_NURSE_0: AnaCarePatientMonthProviderAggregate = {
  anaCarePatientId: 'AC-PAT-0',
  anaCareNurseId: 'AC-NURSE-0',
  nurseFirstName: 'Rocío',
  nurseLastName: 'García QA',
};

/**
 * F2 (migration 457): STUB de `SyncRunRepository` só com `getConclusion` fixo — os outros 3
 * métodos da porta (`startNewRun`/`getRunStartedAt`/`recordProgress`) nunca são chamados por
 * `getMonthSnapshot` (são do lado do controller de SYNC, fora do escopo desta leitura).
 */
function stubSyncRunRepo(conclusion: SyncRunConclusion): SyncRunRepository {
  return {
    getConclusion: jest.fn().mockResolvedValue(conclusion),
    startNewRun: jest.fn(),
    getRunStartedAt: jest.fn(),
    recordProgress: jest.fn(),
  };
}

describe('isValidMonth / periodMonthDate', () => {
  it('aceita YYYY-MM válido', () => {
    expect(isValidMonth('2026-09')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-00')).toBe(false);
    expect(isValidMonth('26-09')).toBe(false);
    expect(isValidMonth('lixo')).toBe(false);
  });

  it('periodMonthDate devolve o 1º dia do mês', () => {
    expect(periodMonthDate('2026-09')).toBe('2026-09-01');
  });
});

describe('AnaCareHoursService', () => {
  describe('getMonthSnapshot', () => {
    // Prova central da separação de caminhos (F6.2): a LISTA lê do retrato AGREGADO
    // (`PatientMonthSyncRepository`), NUNCA da fonte — se alguém religar `getMonthSnapshot` a
    // `source.listShifts`, este teste morre.
    it('NUNCA chama source.listShifts — lê exclusivamente do retrato AGREGADO (PatientMonthSyncRepository)', async () => {
      const source = new StubSource([SHIFT_A]);
      const listShiftsSpy = jest.spyOn(source, 'listShifts');
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0], [PROVIDER_PAT_0_NURSE_0]);
      const service = new AnaCareHoursService(source, mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      await service.getMonthSnapshot('2026-09', false);
      expect(listShiftsSpy).not.toHaveBeenCalled();
    });

    // Contagem zero é falha, nunca sucesso: sem NENHUM agregado gravado pro mês, o retrato nunca
    // foi construído — o snapshot não pode virar "lista vazia" silenciosa, tem de sair `stale: true`.
    it('mês sem agregados ⇒ stale=true (retrato AGREGADO não construído), nunca lista vazia silenciosa', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([]); // freshness.shifts === 0
      const service = new AnaCareHoursService(new StubSource([]), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.patients).toEqual([]);
      expect(snapshot.stale).toBe(true);
    });

    /**
     * Item 3 (revisão de PR, herdado da F6.1): o `stale: true` acima também dispara quando o
     * retrato SINCRONIZOU e só ficou velho (>24h). Este teste MORRE se `snapshotState` voltar a
     * colapsar em `stale`/`fresco`.
     */
    it('mês sem agregados ⇒ snapshotState=nao_construido (distinto de retrato velho)', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([]);
      const service = new AnaCareHoursService(new StubSource([]), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.snapshotState).toBe('nao_construido');
    });

    it('mês COM agregados e fonte fresca ⇒ stale=false, snapshotState=fresco', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.stale).toBe(false);
      expect(snapshot.snapshotState).toBe('fresco');
    });

    // Contrato F6.2 (Adendo 17/09): a resposta NÃO tem nenhum turno individual — o "termina
    // quando" da fase. Morre se `providers[].shifts` ou qualquer campo por-turno voltar a existir.
    it('a resposta NÃO contém nenhum turno individual (nem em providers) — termina quando da F6.2', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0], [PROVIDER_PAT_0_NURSE_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, true);
      expect(snapshot.patients[0]).not.toHaveProperty('shifts');
      expect(snapshot.patients[0].providers[0]).not.toHaveProperty('shifts');
      expect(JSON.stringify(snapshot)).not.toMatch(/"shifts"/);
    });

    it('devolve os pacientes do agregado com as contagens/somas repassadas campo a campo', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0], [PROVIDER_PAT_0_NURSE_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.patients).toHaveLength(1);
      const patient = snapshot.patients[0];
      expect(patient.anaCareId).toBe('AC-PAT-0');
      expect(patient.providersCount).toBe(1);
      expect(patient.shiftsCount).toBe(2);
      expect(patient.originSinCheckin).toBe(1);
      expect(patient.originWebAdmin).toBe(0);
      expect(patient.originApp).toBe(1);
    });

    // Adendo 17/09: duas colunas de hora, NUNCA colapsadas — o modo `zero` usa só
    // `hoursActualSum`; somada a `hoursScheduledSumMissingActual` cobre o modo previsto.
    it('as duas somas de hora saem SEPARADAS (hoursActualSum / hoursScheduledSumMissingActual), nunca somadas pelo serviço', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.patients[0].hoursActualSum).toBe(11.8);
      expect(snapshot.patients[0].hoursScheduledSumMissingActual).toBe(6);
    });

    // Adendo 17/09: `validated`/`contested` vêm do GROUP BY de `shift_hours_validation`
    // (`getStatusCountsByMonth`), nunca mais do join 1:1 por turno.
    it('validated/contested vêm do GROUP BY de shift_hours_validation (getStatusCountsByMonth), nunca de turno individual', async () => {
      const validationCounts = new Map([['AC-PAT-0', { validated: 3, contested: 1 }]]);
      const repo = mockRepo({ getStatusCountsByMonth: jest.fn().mockResolvedValue(validationCounts) });
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
      const service = new AnaCareHoursService(new StubSource(), repo, new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.patients[0].validated).toBe(3);
      expect(snapshot.patients[0].contested).toBe(1);
      expect(repo.getStatusCountsByMonth).toHaveBeenCalledWith('2026-09-01');
    });

    it('paciente sem nenhuma linha em shift_hours_validation ⇒ validated=0, contested=0 (nunca undefined)', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.patients[0].validated).toBe(0);
      expect(snapshot.patients[0].contested).toBe(0);
    });

    // Adendo 17/09: paciente com 2 prestadores — `providers` continua array (não só contagem),
    // cada um com nome, para o filtro "Todos los prestadores" do front seguir funcionando.
    it('paciente com 2 prestadores: providersCount=2 no agregado e providers[] devolve os DOIS, cada um com nome', async () => {
      const aggregateDoisPrestadores: AnaCarePatientMonthAggregate = { ...AGGREGATE_PAT_0, providersCount: 2 };
      const providerB: AnaCarePatientMonthProviderAggregate = {
        anaCarePatientId: 'AC-PAT-0',
        anaCareNurseId: 'AC-NURSE-1',
        nurseFirstName: 'Outra',
        nurseLastName: 'Enfermera',
      };
      const patientMonthRepo = new StubPatientMonthRepository([aggregateDoisPrestadores], [PROVIDER_PAT_0_NURSE_0, providerB]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, true);
      expect(snapshot.patients[0].providersCount).toBe(2);
      const ids = snapshot.patients[0].providers.map((p) => p.anaCareId).sort();
      expect(ids).toEqual(['AC-NURSE-0', 'AC-NURSE-1']);
      const names = snapshot.patients[0].providers.map((p) => p.name).sort();
      expect(names).toEqual(['Outra Enfermera', 'Rocío García QA']);
    });

    // D349 item 1: nome do prestador vem do PAR (migration 442), nunca de `workers`/KMS.
    it('D349/item 1: prestador com ana_care_id em workers vem linked=true; nome vem do PAR (nunca de workers/KMS), quando canReadProviderName=true', async () => {
      const decrypt = jest.fn().mockResolvedValue('nunca deveria decifrar nome de prestador');
      const kms = { decrypt, encrypt: jest.fn() } as unknown as KMSEncryptionService;
      const workerLinks = mockWorkerLinks(new Map([['AC-NURSE-0', { workerId: 'w-1', firstNameEncrypted: 'enc-first', lastNameEncrypted: 'enc-last' }]]));
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0], [PROVIDER_PAT_0_NURSE_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), kms, workerLinks, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, true);
      const provider = snapshot.patients[0].providers.find((p) => p.anaCareId === 'AC-NURSE-0')!;
      expect(provider.linked).toBe(true);
      expect(provider.name).toBe('Rocío García QA');
      // Item 1: nome não decifra mais `workers` — KMS nunca é chamado pra resolver nome de prestador.
      expect(decrypt).not.toHaveBeenCalled();
    });

    it('D349/D344: prestador vinculado, mas SEM worker_contact:read (canReadProviderName=false) — linked=true, name undefined MESMO o par tendo nome', async () => {
      const workerLinks = mockWorkerLinks(new Map([['AC-NURSE-0', { workerId: 'w-1', firstNameEncrypted: null, lastNameEncrypted: null }]]));
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0], [PROVIDER_PAT_0_NURSE_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), workerLinks, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, false);
      const provider = snapshot.patients[0].providers.find((p) => p.anaCareId === 'AC-NURSE-0')!;
      expect(provider.linked).toBe(true);
      expect(provider.name).toBeUndefined();
    });

    /**
     * Item 1 (17/09): nome e vínculo são INDEPENDENTES — o prestador pode não casar com nenhum
     * worker nosso e ainda assim mostrar o nome, se o par tem nome e o ator tem `worker_contact:read`.
     */
    it('sem match em workers.ana_care_id: linked=false, mas o NOME do par aparece do mesmo jeito (item 1)', async () => {
      const workerLinks = mockWorkerLinks(new Map());
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0], [PROVIDER_PAT_0_NURSE_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), workerLinks, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, true);
      const provider = snapshot.patients[0].providers.find((p) => p.anaCareId === 'AC-NURSE-0')!;
      expect(provider.linked).toBe(false);
      expect(provider.name).toBe('Rocío García QA');
    });

    it('busca o vínculo em LOTE: um único findByAnaCareIds com os anaCareNurseId DISTINTOS do mês (nunca 1-por-par)', async () => {
      const providerB: AnaCarePatientMonthProviderAggregate = { anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-1' };
      const providerRepetido: AnaCarePatientMonthProviderAggregate = { anaCarePatientId: 'AC-PAT-1', anaCareNurseId: 'AC-NURSE-0' };
      const workerLinks = mockWorkerLinks(new Map());
      const patientMonthRepo = new StubPatientMonthRepository(
        [AGGREGATE_PAT_0, { ...AGGREGATE_PAT_0, anaCarePatientId: 'AC-PAT-1' }],
        [PROVIDER_PAT_0_NURSE_0, providerB, providerRepetido],
      );
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), workerLinks, patientMonthRepo);

      await service.getMonthSnapshot('2026-09', false, true);
      expect(workerLinks.findByAnaCareIds).toHaveBeenCalledTimes(1);
      const [ids] = (workerLinks.findByAnaCareIds as jest.Mock).mock.calls[0];
      expect([...ids].sort()).toEqual(['AC-NURSE-0', 'AC-NURSE-1']);
    });

    it('paciente permanece linked=false mesmo com prestador vinculado (D349 item 2, bloqueado)', async () => {
      const workerLinks = mockWorkerLinks(new Map([['AC-NURSE-0', { workerId: 'w-1', firstNameEncrypted: null, lastNameEncrypted: null }]]));
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0], [PROVIDER_PAT_0_NURSE_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), workerLinks, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, true);
      expect(snapshot.patients[0].linked).toBe(false);
    });

    /** Item 1 (17/09): o nome do paciente vem do agregado independente de `linked` (sempre false, D349 item 2). */
    it('nome do paciente vem do AGREGADO mesmo com linked=false — não depende de canReadProviderName (gate é só do prestador)', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, false);
      expect(snapshot.patients[0].linked).toBe(false);
      expect(snapshot.patients[0].name).toBe('Lucía Fernández QA');
    });

    it('nome do paciente ausente no agregado (patientFirstName/patientLastName undefined) vem name undefined, nunca inventado', async () => {
      const aggregateSemNome: AnaCarePatientMonthAggregate = { ...AGGREGATE_PAT_0, patientFirstName: undefined, patientLastName: undefined };
      const patientMonthRepo = new StubPatientMonthRepository([aggregateSemNome]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, false);
      expect(snapshot.patients[0].name).toBeUndefined();
    });

    /**
     * F2 (change `anacare-horas-conclusao-de-corrida`, migration 457) — prova de PONTA A PONTA
     * (repositório STUB → serviço → `buildSnapshot`) de que `getMonthSnapshot` lê a conclusão da
     * corrida e a repassa. As 5 ramificações de precedência em si (unitárias, sem passar pelo
     * serviço inteiro) estão em `AnaCareHoursMapper.test.ts` — aqui só provamos a FIAÇÃO.
     */
    describe('F2 — conclusão da corrida (parcial/desconhecido)', () => {
      it('conclusão status=null (linha antiga, sem coluna preenchida) ⇒ snapshotState=desconhecido, NUNCA parcial', async () => {
        const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
        const syncRunRepo = stubSyncRunRepo({ status: null, reservationsTotal: null, reservationsDone: null });
        const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo, undefined, syncRunRepo);

        const snapshot = await service.getMonthSnapshot('2026-09', false);
        expect(snapshot.snapshotState).toBe('desconhecido');
        expect(snapshot.snapshotState).not.toBe('parcial');
      });

      it('conclusão status=running com contagens ⇒ snapshotState=parcial e o snapshot carrega reservationsTotal/reservationsDone', async () => {
        const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
        const syncRunRepo = stubSyncRunRepo({ status: 'running', reservationsTotal: 144, reservationsDone: 49 });
        const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo, undefined, syncRunRepo);

        const snapshot = await service.getMonthSnapshot('2026-09', false);
        expect(snapshot.snapshotState).toBe('parcial');
        expect(snapshot.reservationsTotal).toBe(144);
        expect(snapshot.reservationsDone).toBe(49);
      });

      /**
       * CONTROLE POSITIVO OBRIGATÓRIO (Decisão 9/design.md §F2), agora de PONTA A PONTA pelo
       * serviço: sabota o estado para 49 de 144 reservas (`status='done'`) — a régua tem que
       * DEIXAR de dizer `fresco`.
       */
      it('CONTROLE POSITIVO — done com 49/144 reservas (sabotado) ⇒ parcial, NUNCA fresco', async () => {
        const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
        const syncRunRepo = stubSyncRunRepo({ status: 'done', reservationsTotal: 144, reservationsDone: 49 });
        const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo, undefined, syncRunRepo);

        const snapshot = await service.getMonthSnapshot('2026-09', false);
        expect(snapshot.snapshotState).toBe('parcial');
        expect(snapshot.snapshotState).not.toBe('fresco');
        expect(snapshot.reservationsTotal).toBe(144);
        expect(snapshot.reservationsDone).toBe(49);
      });

      it('conclusão status=done com reservationsDone===reservationsTotal ⇒ snapshotState=fresco (corrida terminou completa)', async () => {
        const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
        const syncRunRepo = stubSyncRunRepo({ status: 'done', reservationsTotal: 144, reservationsDone: 144 });
        const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo, undefined, syncRunRepo);

        const snapshot = await service.getMonthSnapshot('2026-09', false);
        expect(snapshot.snapshotState).toBe('fresco');
        expect(snapshot.reservationsTotal).toBeUndefined();
        expect(snapshot.reservationsDone).toBeUndefined();
      });

      it('chama getConclusion com a fonte e o mês certos (PATIENT_MONTH_SOURCE, mesmo mês pedido)', async () => {
        const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
        const syncRunRepo = stubSyncRunRepo({ status: 'done', reservationsTotal: 1, reservationsDone: 1 });
        const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo, undefined, syncRunRepo);

        await service.getMonthSnapshot('2026-09', false);
        expect(syncRunRepo.getConclusion).toHaveBeenCalledWith('anacare', '2026-09');
      });
    });
  });

  describe('getPatientMonth', () => {
    it('devolve o paciente quando existe no mês', async () => {
      const service = new AnaCareHoursService(new StubSource(), mockRepo());
      const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false);
      expect(patient?.anaCareId).toBe('AC-PAT-0');
    });

    it('devolve null quando o paciente não tem turno no mês', async () => {
      const service = new AnaCareHoursService(new StubSource(), mockRepo());
      expect(await service.getPatientMonth('2026-09', 'AC-PAT-999', false)).toBeNull();
    });

    it('D349: repassa canReadProviderName também em getPatientMonth', async () => {
      const workerLinks = mockWorkerLinks(new Map([['AC-NURSE-0', { workerId: 'w-1', firstNameEncrypted: null, lastNameEncrypted: null }]]));
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), workerLinks);
      const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, true);
      expect(patient?.providers[0].linked).toBe(true);
    });

    /**
     * Item 4 (18/09), gate de PII: ator SEM `patient_identity:read` (5º parâmetro omitido, default
     * `false`) — documento AUSENTE (`undefined`), mesmo com a fonte tendo mandado o par completo.
     * `undefined`, não vazio/redigido: mesma convenção de `nurseName`/`worker_contact:read`.
     */
    it('item 4 (18/09): SEM patient_identity:read — documentType/documentNumber ausentes mesmo com a fonte mandando o par', async () => {
      const service = new AnaCareHoursService(new StubSource(), mockRepo());
      const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false);
      expect(patient?.documentType).toBeUndefined();
      expect(patient?.documentNumber).toBeUndefined();
    });

    /** Item 4 (18/09): COM `patient_identity:read` (6º parâmetro `true`) — documento presente. */
    it('item 4 (18/09): COM patient_identity:read — documentType/documentNumber presentes, vindos da fonte', async () => {
      const service = new AnaCareHoursService(new StubSource(), mockRepo());
      const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, true);
      expect(patient?.documentType).toBe('DNI');
      expect(patient?.documentNumber).toBe('30999888');
    });

    /**
     * Item 5 (19/09, migration 446): fallback do documento REGISTRADO manualmente quando a fonte
     * (Ana Care) não manda `patientDocumentNumber` para o turno. Gate continua o mesmo
     * (`patient_identity:read`) — o documento registrado é PII igual ao original.
     */
    describe('fallback do documento registrado (item 5, migration 446)', () => {
      function mockPatientDocuments(
        overrides: Partial<jest.Mocked<IAnaCarePatientDocumentRepository>> = {},
      ): jest.Mocked<IAnaCarePatientDocumentRepository> {
        return {
          findByPatientId: jest.fn().mockResolvedValue(null),
          insert: jest.fn(),
          ...overrides,
        };
      }

      const REGISTERED: AnaCarePatientDocumentRecord = {
        id: 'doc-1',
        anaCarePatientId: 'AC-PAT-0',
        documentNumber: '40111222',
        documentType: 'DNI',
        registeredBy: 'uid-staff-1',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      };

      function makeSourceSemDocumento(): StubSource {
        const shiftSemDocumento: SourceShiftDTO = { ...SHIFT_A, patientDocumentType: null, patientDocumentNumber: null };
        return new StubSource([shiftSemDocumento]);
      }

      it('fonte SEM documento + patient_identity:read → usa o documento REGISTRADO', async () => {
        const patientDocuments = mockPatientDocuments({ findByPatientId: jest.fn().mockResolvedValue(REGISTERED) });
        const service = new AnaCareHoursService(
          makeSourceSemDocumento(),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          patientDocuments,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, true);

        expect(patient?.documentType).toBe('DNI');
        expect(patient?.documentNumber).toBe('40111222');
        expect(patientDocuments.findByPatientId).toHaveBeenCalledWith('AC-PAT-0');
      });

      /**
       * A2 (achado do gate `revisao-pr`, 25/09/2026, REVISÃO desta asserção): antes, o teste
       * afirmava que SEM `patient_identity:read` o registrado nunca era consultado. Isso só valia
       * porque, até a correção, a busca do Axonico dependia do campo EXPOSTO (gated) — ninguém
       * mais chamava `findByPatientId` sem a célula. Agora `resolveDocumentNumberForAxonico`
       * consulta o REGISTRADO de qualquer forma (é a CHAVE interna do Axonico, nunca devolvida ao
       * chamador) — o que continua intacto é só o campo EXPOSTO (`documentType`/`documentNumber`
       * no `AnaCarePatient`), que seguem `undefined` sem a célula.
       */
      it('fonte SEM documento + SEM patient_identity:read → CONSULTA o registrado (chave interna do Axonico), mas o campo EXPOSTO continua ausente (gate intacto)', async () => {
        const patientDocuments = mockPatientDocuments({ findByPatientId: jest.fn().mockResolvedValue(REGISTERED) });
        const service = new AnaCareHoursService(
          makeSourceSemDocumento(),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          patientDocuments,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, false);

        expect(patient?.documentType).toBeUndefined();
        expect(patient?.documentNumber).toBeUndefined();
        expect(patientDocuments.findByPatientId).toHaveBeenCalledWith('AC-PAT-0');
      });

      it('fonte COM documento — NUNCA consulta o registrado (fonte tem precedência, fallback só cobre ausência)', async () => {
        const patientDocuments = mockPatientDocuments();
        const service = new AnaCareHoursService(
          new StubSource(), // SHIFT_A já tem patientDocumentNumber
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          patientDocuments,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, true);

        expect(patient?.documentNumber).toBe('30999888'); // da fonte, não do registrado
        expect(patientDocuments.findByPatientId).not.toHaveBeenCalled();
      });

      it('fonte SEM documento e SEM registro → documento ausente (undefined), nunca quebra', async () => {
        const patientDocuments = mockPatientDocuments({ findByPatientId: jest.fn().mockResolvedValue(null) });
        const service = new AnaCareHoursService(
          makeSourceSemDocumento(),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          patientDocuments,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, true);

        expect(patient?.documentType).toBeUndefined();
        expect(patient?.documentNumber).toBeUndefined();
      });
    });

    // Contraparte da prova em `getMonthSnapshot` — o DETALHE segue AO VIVO na fonte, com
    // {month, patientId}. Morre se alguém trocar `getPatientMonth` para ler do retrato.
    it('SEMPRE chama source.listShifts com {month, patientId} — caminho ao vivo, nunca o retrato', async () => {
      const source = new StubSource();
      const listShiftsSpy = jest.spyOn(source, 'listShifts');
      const service = new AnaCareHoursService(source, mockRepo());

      await service.getPatientMonth('2026-09', 'AC-PAT-0', false);
      expect(listShiftsSpy).toHaveBeenCalledWith({ month: '2026-09', patientId: 'AC-PAT-0' });
    });

    /**
     * F6.2: o contrato da LISTA (`getMonthSnapshot`) não expõe mais nota/turno individual, então a
     * cobertura da decifra de nota (`buildPatients`) migra para cá — o DETALHE (`getPatientMonth`)
     * é o único caminho que ainda passa por `mapShift`/nota, e não foi tocado por esta fase.
     */
    it('decifra a nota do DETALHE só quando canReadNote=true (e só se houver validação com nota)', async () => {
      const decrypt = jest.fn().mockResolvedValue('nota decifrada');
      const kms = { decrypt, encrypt: jest.fn() } as unknown as KMSEncryptionService;
      const validation: ValidationRow = {
        sourceShiftId: 'shift-a',
        status: 'contestado',
        approvedHours: null,
        approvedCheckinAt: null,
        approvedCheckoutAt: null,
        approvedCheckinSource: null,
        validatedBy: null,
        validatedByName: null,
        validatedAt: null,
        reason: 'otro',
        noteEncrypted: 'cifra',
      };
      const repo = mockRepo({ getByShiftIds: jest.fn().mockResolvedValue(new Map([['shift-a', validation]])) });
      const service = new AnaCareHoursService(new StubSource(), repo, kms);

      const semCelula = await service.getPatientMonth('2026-09', 'AC-PAT-0', false);
      const shiftSemCelula = semCelula!.providers[0].shifts.find((s) => s.id === 'shift-a')!;
      expect(shiftSemCelula.contestNote).toBeUndefined();
      expect(decrypt).not.toHaveBeenCalled();

      const comCelula = await service.getPatientMonth('2026-09', 'AC-PAT-0', true);
      const shiftComCelula = comCelula!.providers[0].shifts.find((s) => s.id === 'shift-a')!;
      expect(shiftComCelula.contestNote).toBe('nota decifrada');
      expect(decrypt).toHaveBeenCalledWith('cifra');
    });

    /**
     * change `axonico-envio-rastreavel` (24/09/2026): `getPatientMonth` anexa `AnaCareShift.axonico`
     * a cada dia com lançamento `enviado` no mês — casado por `service_date`, não por turno. Injeta
     * um `IAxonicoLancamentoRepository` MOCKADO (jest) como 8º parâmetro posicional (nunca o real —
     * mesmo padrão de `mockRepo`/`mockPatientDocuments` para as outras portas).
     */
    describe('axonico (change axonico-envio-rastreavel, migration 473)', () => {
      function mockLancamentoRepository(
        overrides: Partial<jest.Mocked<IAxonicoLancamentoRepository>> = {},
      ): jest.Mocked<IAxonicoLancamentoRepository> {
        return {
          findSentByDocumentAndMonth: jest.fn().mockResolvedValue([]),
          ...overrides,
        } as unknown as jest.Mocked<IAxonicoLancamentoRepository>;
      }

      const SENT_RECORD: AxonicoLancamentoSentRecord = {
        serviceDate: '2026-09-10', // mesmo dia de SHIFT_A/SHIFT_SEM_CHECKIN
        numeroComprobante: 'CMP-777',
        codAutorizacion: 'AUT-777',
        createdAt: new Date('2026-09-10T15:00:00.000Z'),
        sentBy: 'uid-staff-9',
        sentByName: 'Elizabeth Soñez',
      };

      it('COM patient_identity:read e documentNumber presente: anexa axonico a TODOS os turnos do dia casado (SHIFT_A e SHIFT_SEM_CHECKIN, mesmo dia), consultando pelo documentNumber+AT+mês', async () => {
        const lancamentoRepository = mockLancamentoRepository({
          findSentByDocumentAndMonth: jest.fn().mockResolvedValue([SENT_RECORD]),
        });
        const service = new AnaCareHoursService(
          new StubSource(),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          undefined,
          undefined,
          lancamentoRepository,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, true);

        expect(lancamentoRepository.findSentByDocumentAndMonth).toHaveBeenCalledWith('30999888', 'AT', '2026-09-01');
        const shifts = patient!.providers[0].shifts;
        expect(shifts).toHaveLength(2); // SHIFT_A + SHIFT_SEM_CHECKIN, mesmo dia 2026-09-10
        for (const shift of shifts) {
          expect(shift.axonico).toEqual({
            status: 'enviado',
            numeroComprobante: 'CMP-777',
            codAutorizacion: 'AUT-777',
            sentAt: '2026-09-10T15:00:00.000Z',
            sentBy: { uid: 'uid-staff-9', displayName: 'Elizabeth Soñez' },
          });
        }
      });

      /**
       * A2 (achado do gate `revisao-pr`, 25/09/2026): ANTES desta correção, a busca do Axonico só
       * rodava quando `patient.documentNumber` saía no payload exposto — que é gated por
       * `patient_identity:read`. Sem a célula, `getPatientMonth` NUNCA consultava
       * `findSentByDocumentAndMonth`, e o dia perdia `axonico` a cada reload para quem não tem a
       * célula, mesmo já lançado por outra pessoa. Agora a CHAVE de busca vem direto da FONTE
       * (`SourceShiftDTO.patientDocumentNumber`, sempre presente independente do gate) — a busca
       * roda igual, `axonico` é anexado igual; só o campo EXPOSTO (`patient.documentNumber`)
       * continua ausente, porque esse sim é PII gated.
       */
      it('SEM patient_identity:read (documentNumber ausente no paciente EXPOSTO): AINDA ASSIM consulta findSentByDocumentAndMonth com o documento da FONTE e anexa axonico', async () => {
        const lancamentoRepository = mockLancamentoRepository({
          findSentByDocumentAndMonth: jest.fn().mockResolvedValue([SENT_RECORD]),
        });
        const service = new AnaCareHoursService(
          new StubSource(),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          undefined,
          undefined,
          lancamentoRepository,
        );

        // canReadPatientDocument=false (5º parâmetro, default) — patient.documentNumber (EXPOSTO)
        // fica undefined, mas SHIFT_A.patientDocumentNumber ('30999888') é a chave usada por baixo.
        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false);

        expect(patient!.documentNumber).toBeUndefined(); // gate intacto no campo exposto
        expect(lancamentoRepository.findSentByDocumentAndMonth).toHaveBeenCalledWith('30999888', 'AT', '2026-09-01');
        expect(patient!.providers[0].shifts.every((s) => s.axonico?.numeroComprobante === 'CMP-777')).toBe(true);
      });

      it('A2 — SEM patient_identity:read E a fonte não mandou documento (só existe no REGISTRADO manualmente): ainda assim consulta e anexa axonico pelo fallback', async () => {
        const shiftSemDocumentoNaFonte: SourceShiftDTO = { ...SHIFT_A, patientDocumentType: null, patientDocumentNumber: null };
        const patientDocuments = {
          findByPatientId: jest.fn().mockResolvedValue({
            id: 'doc-1', anaCarePatientId: 'AC-PAT-0', documentNumber: '40111222', documentType: 'DNI',
            registeredBy: 'uid-staff-1', createdAt: new Date(), updatedAt: new Date(),
          }),
          insert: jest.fn(),
        };
        const lancamentoRepository = mockLancamentoRepository({
          findSentByDocumentAndMonth: jest.fn().mockResolvedValue([SENT_RECORD]),
        });
        const service = new AnaCareHoursService(
          new StubSource([shiftSemDocumentoNaFonte]),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          patientDocuments,
          undefined,
          lancamentoRepository,
        );

        // canReadPatientDocument=false — o campo EXPOSTO fica undefined mesmo com fallback existindo.
        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false);

        expect(patient!.documentNumber).toBeUndefined();
        expect(patientDocuments.findByPatientId).toHaveBeenCalledWith('AC-PAT-0');
        expect(lancamentoRepository.findSentByDocumentAndMonth).toHaveBeenCalledWith('40111222', 'AT', '2026-09-01');
        expect(patient!.providers[0].shifts[0].axonico?.numeroComprobante).toBe('CMP-777');
      });

      it('A2 — SEM patient_identity:read, fonte sem documento E sem registro nenhum: nunca consulta (não há chave), axonico ausente, sem erro', async () => {
        const shiftSemDocumentoNenhum: SourceShiftDTO = { ...SHIFT_A, patientDocumentType: null, patientDocumentNumber: null };
        const patientDocuments = { findByPatientId: jest.fn().mockResolvedValue(null), insert: jest.fn() };
        const lancamentoRepository = mockLancamentoRepository({
          findSentByDocumentAndMonth: jest.fn().mockResolvedValue([SENT_RECORD]),
        });
        const service = new AnaCareHoursService(
          new StubSource([shiftSemDocumentoNenhum]),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          patientDocuments,
          undefined,
          lancamentoRepository,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false);

        expect(lancamentoRepository.findSentByDocumentAndMonth).not.toHaveBeenCalled();
        expect(patient!.providers[0].shifts.every((s) => s.axonico === undefined)).toBe(true);
      });

      it('nenhum lançamento enviado no mês (findSentByDocumentAndMonth devolve []): nenhum turno ganha axonico', async () => {
        const lancamentoRepository = mockLancamentoRepository(); // default: []
        const service = new AnaCareHoursService(
          new StubSource(),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          undefined,
          undefined,
          lancamentoRepository,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, true);

        expect(patient!.providers[0].shifts.every((s) => s.axonico === undefined)).toBe(true);
      });

      it('lançamento de um dia DIFERENTE do turno: o turno NÃO casado fica sem axonico (casamento é por service_date, não "qualquer lançamento do mês")', async () => {
        const outroDiaShift: SourceShiftDTO = { ...SHIFT_A, sourceShiftId: 'shift-outro-dia', date: '2026-09-20' };
        const source = new StubSource([SHIFT_A, outroDiaShift]);
        const lancamentoRepository = mockLancamentoRepository({
          // Lançamento só para o dia de SHIFT_A (2026-09-10) — outroDiaShift (2026-09-20) fica de fora.
          findSentByDocumentAndMonth: jest.fn().mockResolvedValue([SENT_RECORD]),
        });
        const service = new AnaCareHoursService(
          source,
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          undefined,
          undefined,
          lancamentoRepository,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, true);
        const shifts = patient!.providers[0].shifts;

        expect(shifts.find((s) => s.id === 'shift-a')?.axonico?.numeroComprobante).toBe('CMP-777');
        expect(shifts.find((s) => s.id === 'shift-outro-dia')?.axonico).toBeUndefined();
      });

      it('sentBy=null no registro (tentativa gravada antes da migration 473): shift.axonico presente, mas SEM a chave sentBy', async () => {
        const lancamentoRepository = mockLancamentoRepository({
          findSentByDocumentAndMonth: jest.fn().mockResolvedValue([{ ...SENT_RECORD, sentBy: null, sentByName: null }]),
        });
        const service = new AnaCareHoursService(
          new StubSource(),
          mockRepo(),
          new KMSEncryptionService(),
          undefined,
          undefined,
          undefined,
          undefined,
          lancamentoRepository,
        );

        const patient = await service.getPatientMonth('2026-09', 'AC-PAT-0', false, false, true);
        const shift = patient!.providers[0].shifts.find((s) => s.id === 'shift-a')!;

        expect(shift.axonico?.status).toBe('enviado');
        expect(shift.axonico).not.toHaveProperty('sentBy');
      });
    });
  });

  /**
   * Conserto 17/09 (passo 2): `getRetratoStatus` migrou do antigo `shiftRepository.getSnapshotFreshness`
   * (retrato por turno, que ninguém mais escrevia desde o passo 1, e cujo repositório foi apagado
   * por completo) para `patientMonthRepository.getSnapshotFreshness` (`anacare_patient_month`) —
   * estes 3 testes passam `patientMonthRepo` (posição 5, desde o passo 3 — o parâmetro do antigo
   * repositório do retrato por turno foi removido do construtor), mesmo double que os testes de
   * `getMonthSnapshot`/`getPatientMonth` acima já usam.
   */
  describe('getRetratoStatus', () => {
    it('retrato construído e fonte fresca → stale=false', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);
      const status = await service.getRetratoStatus('2026-09');
      expect(status).toEqual({ updatedAt: expect.any(String), stale: false, circuitBreakerOpen: false });
    });

    it('retrato NUNCA construído (zero linhas) → stale=true mesmo com a fonte dizendo fresco', async () => {
      const patientMonthRepo = new StubPatientMonthRepository([]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);
      const status = await service.getRetratoStatus('2026-09');
      expect(status.stale).toBe(true);
    });

    it('não chama source.listShifts nem lista o agregado inteiro — só freshness + status da fonte', async () => {
      const source = new StubSource();
      const listShiftsSpy = jest.spyOn(source, 'listShifts');
      const patientMonthRepo = new StubPatientMonthRepository([AGGREGATE_PAT_0]);
      const listByMonthSpy = jest.spyOn(patientMonthRepo, 'listByMonth');
      const service = new AnaCareHoursService(source, mockRepo(), new KMSEncryptionService(), undefined, patientMonthRepo);

      await service.getRetratoStatus('2026-09');
      expect(listShiftsSpy).not.toHaveBeenCalled();
      expect(listByMonthSpy).not.toHaveBeenCalled();
    });
  });

  describe('validateShift', () => {
    it('turno sem check-in valida com 0h congeladas (D344)', async () => {
      const repo = mockRepo();
      const service = new AnaCareHoursService(new StubSource(), repo);
      await service.validateShift('shift-b', 'uid-1');
      expect(repo.validate).toHaveBeenCalledWith(expect.objectContaining({ sourceShiftId: 'shift-b', approvedHours: 0, validatedBy: 'uid-1' }));
    });

    it('turno com previsto e real DIFERENTES valida com a hora REAL (actualStart→actualEnd), nunca com o previsto — morre se `validateShift` voltar a ler um campo de previsto', async () => {
      const shiftPrevistoDiferenteDoReal: SourceShiftDTO = {
        ...SHIFT_A,
        sourceShiftId: 'shift-c',
        scheduledStart: '2026-09-10T08:00:00.000Z',
        scheduledEnd: '2026-09-10T20:00:00.000Z', // previsto: 12h
        actualStart: '2026-09-10T08:00:00.000Z',
        actualEnd: '2026-09-10T19:48:00.000Z', // real: 11,8h
      };
      const repo = mockRepo();
      const source = new StubSource([shiftPrevistoDiferenteDoReal]);
      const service = new AnaCareHoursService(source, repo);
      await service.validateShift('shift-c', 'uid-1');
      expect(repo.validate).toHaveBeenCalledWith(expect.objectContaining({ sourceShiftId: 'shift-c', approvedHours: 11.8 }));
    });

    it('turno inexistente na fonte → TURNO_NAO_ENCONTRADO', async () => {
      const service = new AnaCareHoursService(new StubSource(), mockRepo());
      await expect(service.validateShift('nao-existe', 'uid-1')).rejects.toMatchObject({ code: 'TURNO_NAO_ENCONTRADO' });
    });

    it('turno já validado → JA_VALIDADO', async () => {
      const repo = mockRepo({ validate: jest.fn().mockRejectedValue(new ShiftAlreadyValidatedError()) });
      const service = new AnaCareHoursService(new StubSource(), repo);
      await expect(service.validateShift('shift-a', 'uid-1')).rejects.toMatchObject({ code: 'JA_VALIDADO' });
    });

    it('erro inesperado do repositório propaga tal qual (não vira AnaCareHoursServiceError)', async () => {
      const erroDeBanco = new Error('conexão caiu');
      const repo = mockRepo({ validate: jest.fn().mockRejectedValue(erroDeBanco) });
      const service = new AnaCareHoursService(new StubSource(), repo);
      await expect(service.validateShift('shift-a', 'uid-1')).rejects.toBe(erroDeBanco);
    });

    // Conserto de conformidade (15/09) — spec "retrato desatualizado bloqueia a validação no
    // serviço e na tela": o bloqueio SHALL existir nas duas camadas, não só na UI.
    it('🔴 retrato stale → RETRATO_DESATUALIZADO, sem tocar o repositório nem a fonte do turno', async () => {
      const repo = mockRepo();
      const source = new StubSource([SHIFT_A, SHIFT_SEM_CHECKIN], { stale: true, circuitBreakerOpen: false });
      const getShiftSpy = jest.spyOn(source, 'getShift');
      const service = new AnaCareHoursService(source, repo);
      await expect(service.validateShift('shift-a', 'uid-1')).rejects.toMatchObject({ code: 'RETRATO_DESATUALIZADO' });
      expect(repo.validate).not.toHaveBeenCalled();
      expect(getShiftSpy).not.toHaveBeenCalled();
    });

    it('🔴 disjuntor aberto (mesmo com stale=false) → RETRATO_DESATUALIZADO', async () => {
      const repo = mockRepo();
      const source = new StubSource([SHIFT_A, SHIFT_SEM_CHECKIN], { stale: false, circuitBreakerOpen: true });
      const service = new AnaCareHoursService(source, repo);
      await expect(service.validateShift('shift-a', 'uid-1')).rejects.toMatchObject({ code: 'RETRATO_DESATUALIZADO' });
      expect(repo.validate).not.toHaveBeenCalled();
    });
  });

  describe('validateBatch', () => {
    it('valida cada turno e reporta resultado por item — um 409 isolado não derruba os demais', async () => {
      const repo = mockRepo({
        validate: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new ShiftAlreadyValidatedError()),
      });
      const service = new AnaCareHoursService(new StubSource(), repo);
      const results = await service.validateBatch(['shift-a', 'shift-b'], 'uid-1');
      expect(results).toEqual([
        { shiftId: 'shift-a', ok: true },
        { shiftId: 'shift-b', ok: false, code: 'JA_VALIDADO' },
      ]);
    });

    it('item com erro inesperado (não AnaCareHoursServiceError) vira code ERRO_DESCONHECIDO no resultado', async () => {
      const repo = mockRepo({ validate: jest.fn().mockRejectedValue(new Error('conexão caiu')) });
      const service = new AnaCareHoursService(new StubSource(), repo);
      const results = await service.validateBatch(['shift-a'], 'uid-1');
      expect(results).toEqual([{ shiftId: 'shift-a', ok: false, code: 'ERRO_DESCONHECIDO' }]);
    });

    it('lote acima do limite recusa ANTES de tocar o repositório', async () => {
      const repo = mockRepo();
      const service = new AnaCareHoursService(new StubSource(), repo);
      const shiftIds = Array.from({ length: VALIDATE_BATCH_MAX_SHIFTS + 1 }, (_, i) => `s${i}`);
      await expect(service.validateBatch(shiftIds, 'uid-1')).rejects.toBeInstanceOf(AnaCareHoursServiceError);
      expect(repo.validate).not.toHaveBeenCalled();
    });

    it('🔴 retrato stale → CADA item do lote sai RETRATO_DESATUALIZADO (batch parcial, mesmo padrão do JA_VALIDADO)', async () => {
      const repo = mockRepo();
      const source = new StubSource([SHIFT_A, SHIFT_SEM_CHECKIN], { stale: true, circuitBreakerOpen: false });
      const service = new AnaCareHoursService(source, repo);
      const results = await service.validateBatch(['shift-a', 'shift-b'], 'uid-1');
      expect(results).toEqual([
        { shiftId: 'shift-a', ok: false, code: 'RETRATO_DESATUALIZADO' },
        { shiftId: 'shift-b', ok: false, code: 'RETRATO_DESATUALIZADO' },
      ]);
      expect(repo.validate).not.toHaveBeenCalled();
    });
  });

  describe('contestShift', () => {
    it('cifra a nota com KMS antes de gravar', async () => {
      const encrypt = jest.fn().mockResolvedValue('cifra-base64');
      const kms = { encrypt, decrypt: jest.fn() } as unknown as KMSEncryptionService;
      const repo = mockRepo();
      const service = new AnaCareHoursService(new StubSource(), repo, kms);
      await service.contestShift('shift-a', 'otro', 'nota livre');
      expect(encrypt).toHaveBeenCalledWith('nota livre');
      expect(repo.contest).toHaveBeenCalledWith(expect.objectContaining({ reason: 'otro', noteEncrypted: 'cifra-base64' }));
    });

    it('sem nota: noteEncrypted fica null e o KMS não é chamado', async () => {
      const encrypt = jest.fn();
      const kms = { encrypt, decrypt: jest.fn() } as unknown as KMSEncryptionService;
      const repo = mockRepo();
      const service = new AnaCareHoursService(new StubSource(), repo, kms);
      await service.contestShift('shift-a', 'otro', undefined);
      expect(encrypt).not.toHaveBeenCalled();
      expect(repo.contest).toHaveBeenCalledWith(expect.objectContaining({ noteEncrypted: null }));
    });

    it('nota acima do limite → NOTA_MUITO_LONGA, sem tocar o KMS nem o repositório', async () => {
      const encrypt = jest.fn();
      const kms = { encrypt, decrypt: jest.fn() } as unknown as KMSEncryptionService;
      const repo = mockRepo();
      const service = new AnaCareHoursService(new StubSource(), repo, kms);
      const notaGigante = 'x'.repeat(501);
      await expect(service.contestShift('shift-a', 'otro', notaGigante)).rejects.toMatchObject({ code: 'NOTA_MUITO_LONGA' });
      expect(encrypt).not.toHaveBeenCalled();
      expect(repo.contest).not.toHaveBeenCalled();
    });

    it('turno inexistente → TURNO_NAO_ENCONTRADO', async () => {
      const service = new AnaCareHoursService(new StubSource(), mockRepo());
      await expect(service.contestShift('nao-existe', 'otro', undefined)).rejects.toMatchObject({ code: 'TURNO_NAO_ENCONTRADO' });
    });

    it('turno já validado → JA_VALIDADO', async () => {
      const repo = mockRepo({ contest: jest.fn().mockRejectedValue(new ShiftAlreadyValidatedError()) });
      const service = new AnaCareHoursService(new StubSource(), repo);
      await expect(service.contestShift('shift-a', 'otro', undefined)).rejects.toMatchObject({ code: 'JA_VALIDADO' });
    });

    it('erro inesperado do repositório propaga tal qual (não vira AnaCareHoursServiceError)', async () => {
      const erroDeBanco = new Error('conexão caiu');
      const repo = mockRepo({ contest: jest.fn().mockRejectedValue(erroDeBanco) });
      const service = new AnaCareHoursService(new StubSource(), repo);
      await expect(service.contestShift('shift-a', 'otro', undefined)).rejects.toBe(erroDeBanco);
    });

    // Conserto de conformidade (15/09) — a spec cobre "tenta validar/CONTESTAR": o mesmo bloqueio.
    it('🔴 retrato stale → RETRATO_DESATUALIZADO, sem tocar KMS nem o repositório', async () => {
      const encrypt = jest.fn();
      const kms = { encrypt, decrypt: jest.fn() } as unknown as KMSEncryptionService;
      const repo = mockRepo();
      const source = new StubSource([SHIFT_A, SHIFT_SEM_CHECKIN], { stale: true, circuitBreakerOpen: false });
      const service = new AnaCareHoursService(source, repo, kms);
      await expect(service.contestShift('shift-a', 'otro', 'nota')).rejects.toMatchObject({ code: 'RETRATO_DESATUALIZADO' });
      expect(encrypt).not.toHaveBeenCalled();
      expect(repo.contest).not.toHaveBeenCalled();
    });

    it('🔴 nota muito longa é checada ANTES do retrato — recusa NOTA_MUITO_LONGA mesmo com retrato stale', async () => {
      // Ordem travada: `contestShift` valida a FORMA do comando (tamanho da nota) antes de bater
      // na fonte (`assertRetratoOk`/`requireSourceShift`) — mesma disciplina de `validateBatch`
      // ("lote acima do limite recusa ANTES de tocar o repositório"), erro de input não deveria
      // depender de round-trip à fonte pra ser recusado.
      const repo = mockRepo();
      const source = new StubSource([SHIFT_A, SHIFT_SEM_CHECKIN], { stale: true, circuitBreakerOpen: false });
      const service = new AnaCareHoursService(source, repo);
      const notaGigante = 'x'.repeat(501);
      await expect(service.contestShift('shift-a', 'otro', notaGigante)).rejects.toMatchObject({ code: 'NOTA_MUITO_LONGA' });
    });
  });
});
