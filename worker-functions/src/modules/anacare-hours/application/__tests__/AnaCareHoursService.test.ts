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
import type { ShiftSyncRepository } from '../../domain/AnaCareHoursSyncPorts';

jest.mock('../../infrastructure/ShiftHoursValidationRepository', () => {
  const actual = jest.requireActual('../../infrastructure/ShiftHoursValidationRepository');
  return {
    ...actual,
    ShiftHoursValidationRepository: jest.fn(),
  };
});

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
  async listShifts(params: { month: string; patientId?: string }): Promise<SourceShiftDTO[]> {
    return this.shifts.filter((s) => !params.patientId || s.anaCarePatientId === params.patientId);
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
    ...overrides,
  } as unknown as jest.Mocked<ShiftHoursValidationRepository>;
}

/**
 * STUB do retrato (`ShiftSyncRepository`) — a LISTA (`getMonthSnapshot`) lê daqui, NUNCA da fonte
 * (espião em `source.listShifts` prova zero chamadas nos testes abaixo). Turnos vazios (`[]`) por
 * default simulam "retrato nunca construído" — quem quiser simular "construído" passa `shifts`.
 */
class StubShiftRepository implements ShiftSyncRepository {
  constructor(
    private readonly shifts: SourceShiftDTO[] = [],
    private readonly lastFetchedAt: string | null = '2026-09-15T00:00:00.000Z',
  ) {}
  async upsertMany(): Promise<{ written: number }> {
    return { written: 0 };
  }
  async listByMonth(_month: string, patientId?: string): Promise<SourceShiftDTO[]> {
    return this.shifts.filter((s) => !patientId || s.anaCarePatientId === patientId);
  }
  async getSnapshotFreshness(): Promise<{ shifts: number; lastFetchedAt: string | null }> {
    return { shifts: this.shifts.length, lastFetchedAt: this.shifts.length > 0 ? this.lastFetchedAt : null };
  }
  async getLastDirectoryCount(): Promise<number | null> {
    return null;
  }
  async setLastDirectoryCount(): Promise<void> {
    /* no-op */
  }
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
    // Prova central da separação de caminhos: a LISTA lê do retrato (banco), NUNCA da fonte —
    // se alguém religar `getMonthSnapshot` a `source.listShifts`, este teste morre.
    it('NUNCA chama source.listShifts — lê exclusivamente do retrato (ShiftSyncRepository)', async () => {
      const source = new StubSource([SHIFT_A, SHIFT_SEM_CHECKIN]);
      const listShiftsSpy = jest.spyOn(source, 'listShifts');
      const shiftRepo = new StubShiftRepository([SHIFT_A, SHIFT_SEM_CHECKIN]);
      const service = new AnaCareHoursService(source, mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);

      await service.getMonthSnapshot('2026-09', false);
      expect(listShiftsSpy).not.toHaveBeenCalled();
    });

    // Contagem zero é falha, nunca sucesso: sem NENHUMA linha gravada pro mês, o retrato nunca foi
    // construído — o snapshot não pode virar "lista vazia" silenciosa, tem de sair `stale: true`.
    it('mês sem linhas no retrato ⇒ stale=true (retrato NÃO construído), nunca lista vazia silenciosa', async () => {
      const shiftRepo = new StubShiftRepository([]); // freshness.shifts === 0
      const service = new AnaCareHoursService(new StubSource([]), mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.patients).toEqual([]);
      expect(snapshot.stale).toBe(true);
    });

    /**
     * Item 3 (revisão de PR): o `stale: true` acima também dispara quando o retrato SINCRONIZOU e
     * só ficou velho (>24h) — a tela usava a MESMA mensagem para os dois casos ("há mais de 24
     * horas"), falsa quando o sync nunca rodou. Este teste MORRE se `snapshotState` voltar a
     * colapsar em `stale`/`fresco`.
     */
    it('mês sem linhas no retrato ⇒ snapshotState=nao_construido (distinto de retrato velho)', async () => {
      const shiftRepo = new StubShiftRepository([]); // freshness.shifts === 0
      const service = new AnaCareHoursService(new StubSource([]), mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.snapshotState).toBe('nao_construido');
    });

    it('mês COM linhas no retrato e fonte fresca ⇒ stale=false, snapshotState=fresco', async () => {
      const shiftRepo = new StubShiftRepository([SHIFT_A]);
      const service = new AnaCareHoursService(new StubSource([SHIFT_A]), mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.stale).toBe(false);
      expect(snapshot.snapshotState).toBe('fresco');
    });

    it('devolve os pacientes agrupados, sem filtro', async () => {
      const shiftRepo = new StubShiftRepository([SHIFT_A, SHIFT_SEM_CHECKIN]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);
      const snapshot = await service.getMonthSnapshot('2026-09', false);
      expect(snapshot.patients).toHaveLength(1);
      expect(snapshot.patients[0].providers[0].shifts).toHaveLength(2);
    });

    // D4 (revisão de conformidade, 15/09): `getMonthSnapshot` deixou de aceitar filtro nenhum —
    // `patientSearch`/`providerId` rodam SÓ no cliente (`selectors.ts` `filterPatients`, front),
    // nunca em query string pro backend (PII em URL/log). As 3 asserções antigas de filtro no
    // service foram substituídas por esta: com 2 prestadores diferentes no mesmo mês, o snapshot
    // devolve os DOIS sempre — não existe mais parâmetro pra podar a resposta aqui.
    it('nunca filtra no servidor — devolve todos os prestadores/pacientes do mês, sem parâmetro de filtro', async () => {
      const shifts = [SHIFT_A, { ...SHIFT_A, sourceShiftId: 'shift-c', anaCareNurseId: 'AC-NURSE-1' }];
      const shiftRepo = new StubShiftRepository(shifts);
      const service = new AnaCareHoursService(new StubSource(shifts), mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);
      const snapshot = await service.getMonthSnapshot('2026-09', false);
      const providerIds = snapshot.patients.flatMap((p) => p.providers.map((pr) => pr.anaCareId)).sort();
      expect(providerIds).toEqual(['AC-NURSE-0', 'AC-NURSE-1']);
    });

    it('decifra a nota só quando canReadNote=true (e só se houver validação com nota)', async () => {
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
      const shiftRepo = new StubShiftRepository([SHIFT_A]);
      const service = new AnaCareHoursService(new StubSource(), repo, kms, undefined, shiftRepo);

      const semCelula = await service.getMonthSnapshot('2026-09', false);
      const shiftSemCelula = semCelula.patients[0].providers[0].shifts.find((s) => s.id === 'shift-a')!;
      expect(shiftSemCelula.contestNote).toBeUndefined();
      expect(decrypt).not.toHaveBeenCalled();

      const comCelula = await service.getMonthSnapshot('2026-09', true);
      const shiftComCelula = comCelula.patients[0].providers[0].shifts.find((s) => s.id === 'shift-a')!;
      expect(shiftComCelula.contestNote).toBe('nota decifrada');
      expect(decrypt).toHaveBeenCalledWith('cifra');
    });

    // D349 item 1: `workers.ana_care_id` já populado pelo MirrorWorkerService — o gap era só o
    // lookup, que agora `resolveProviderLinks` faz em LOTE.
    it('D349: prestador com ana_care_id em workers vem linked=true + nome, quando canReadProviderName=true', async () => {
      const kms = { decrypt: jest.fn().mockImplementation((v: string) => Promise.resolve(v === 'enc-first' ? 'Rocío' : 'García')), encrypt: jest.fn() } as unknown as KMSEncryptionService;
      const workerLinks = mockWorkerLinks(new Map([['AC-NURSE-0', { workerId: 'w-1', firstNameEncrypted: 'enc-first', lastNameEncrypted: 'enc-last' }]]));
      const shiftRepo = new StubShiftRepository([SHIFT_A]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), kms, workerLinks, shiftRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, true);
      const provider = snapshot.patients[0].providers.find((p) => p.anaCareId === 'AC-NURSE-0')!;
      expect(provider.linked).toBe(true);
      expect(provider.name).toBe('Rocío García');
    });

    it('D349/D344: prestador vinculado, mas SEM worker_contact:read (canReadProviderName=false) — linked=true, name undefined, KMS NUNCA chamado', async () => {
      const decrypt = jest.fn().mockResolvedValue('nunca deveria decifrar');
      const kms = { decrypt, encrypt: jest.fn() } as unknown as KMSEncryptionService;
      const workerLinks = mockWorkerLinks(new Map([['AC-NURSE-0', { workerId: 'w-1', firstNameEncrypted: 'enc-first', lastNameEncrypted: 'enc-last' }]]));
      const shiftRepo = new StubShiftRepository([SHIFT_A]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), kms, workerLinks, shiftRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, false);
      const provider = snapshot.patients[0].providers.find((p) => p.anaCareId === 'AC-NURSE-0')!;
      expect(provider.linked).toBe(true);
      expect(provider.name).toBeUndefined();
      expect(decrypt).not.toHaveBeenCalled();
    });

    it('sem match em workers.ana_care_id: linked=false (comportamento igual ao de antes da D349)', async () => {
      const workerLinks = mockWorkerLinks(new Map());
      const shiftRepo = new StubShiftRepository([SHIFT_A]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), workerLinks, shiftRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, true);
      const provider = snapshot.patients[0].providers.find((p) => p.anaCareId === 'AC-NURSE-0')!;
      expect(provider.linked).toBe(false);
      expect(provider.name).toBeUndefined();
    });

    it('busca o vínculo em LOTE: um único findByAnaCareIds com os anaCareNurseId DISTINTOS do mês (nunca 1-por-turno)', async () => {
      const shifts = [SHIFT_A, { ...SHIFT_A, sourceShiftId: 'shift-c', anaCareNurseId: 'AC-NURSE-1' }, { ...SHIFT_A, sourceShiftId: 'shift-d', anaCareNurseId: 'AC-NURSE-0' }];
      const workerLinks = mockWorkerLinks(new Map());
      const shiftRepo = new StubShiftRepository(shifts);
      const service = new AnaCareHoursService(new StubSource(shifts), mockRepo(), new KMSEncryptionService(), workerLinks, shiftRepo);

      await service.getMonthSnapshot('2026-09', false, true);
      expect(workerLinks.findByAnaCareIds).toHaveBeenCalledTimes(1);
      const [ids] = (workerLinks.findByAnaCareIds as jest.Mock).mock.calls[0];
      expect([...ids].sort()).toEqual(['AC-NURSE-0', 'AC-NURSE-1']);
    });

    it('paciente permanece linked=false mesmo com prestador vinculado (D349 item 2, bloqueado)', async () => {
      const workerLinks = mockWorkerLinks(new Map([['AC-NURSE-0', { workerId: 'w-1', firstNameEncrypted: null, lastNameEncrypted: null }]]));
      const shiftRepo = new StubShiftRepository([SHIFT_A]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), workerLinks, shiftRepo);

      const snapshot = await service.getMonthSnapshot('2026-09', false, true);
      expect(snapshot.patients[0].linked).toBe(false);
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

    // Contraparte da prova em `getMonthSnapshot` — o DETALHE segue AO VIVO na fonte, com
    // {month, patientId}. Morre se alguém trocar `getPatientMonth` para ler do retrato.
    it('SEMPRE chama source.listShifts com {month, patientId} — caminho ao vivo, nunca o retrato', async () => {
      const source = new StubSource();
      const listShiftsSpy = jest.spyOn(source, 'listShifts');
      const service = new AnaCareHoursService(source, mockRepo());

      await service.getPatientMonth('2026-09', 'AC-PAT-0', false);
      expect(listShiftsSpy).toHaveBeenCalledWith({ month: '2026-09', patientId: 'AC-PAT-0' });
    });
  });

  describe('getRetratoStatus', () => {
    it('retrato construído e fonte fresca → stale=false', async () => {
      const shiftRepo = new StubShiftRepository([SHIFT_A]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);
      const status = await service.getRetratoStatus('2026-09');
      expect(status).toEqual({ updatedAt: expect.any(String), stale: false, circuitBreakerOpen: false });
    });

    it('retrato NUNCA construído (zero linhas) → stale=true mesmo com a fonte dizendo fresco', async () => {
      const shiftRepo = new StubShiftRepository([]);
      const service = new AnaCareHoursService(new StubSource(), mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);
      const status = await service.getRetratoStatus('2026-09');
      expect(status.stale).toBe(true);
    });

    it('não chama source.listShifts nem mapeia turnos — só freshness + status da fonte', async () => {
      const source = new StubSource();
      const listShiftsSpy = jest.spyOn(source, 'listShifts');
      const shiftRepo = new StubShiftRepository([SHIFT_A]);
      const listByMonthSpy = jest.spyOn(shiftRepo, 'listByMonth');
      const service = new AnaCareHoursService(source, mockRepo(), new KMSEncryptionService(), undefined, shiftRepo);

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
