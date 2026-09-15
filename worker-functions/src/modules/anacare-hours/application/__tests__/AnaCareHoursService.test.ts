/**
 * AnaCareHoursService — fonte STUB (implementa a porta em memória, sem tocar o adapter falso de
 * verdade) + `ShiftHoursValidationRepository` MOCKADO (jest) + KMS real em modo passthrough
 * (`NODE_ENV=test`, ver `KMSEncryptionService`) — prova o round-trip de cifra/decifra sem rede.
 */
import { AnaCareHoursService, isValidMonth, periodMonthDate } from '../AnaCareHoursService';
import { ShiftHoursValidationRepository, ShiftAlreadyValidatedError, type ValidationRow } from '../../infrastructure/ShiftHoursValidationRepository';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { AnaCareHoursServiceError, VALIDATE_BATCH_MAX_SHIFTS } from '../../domain/AnaCareShift';
import type { AnaCareRetratoSourceStatus, AnaCareShiftsSource, SourceShiftDTO } from '../../domain/AnaCareShiftsSource';

jest.mock('../../infrastructure/ShiftHoursValidationRepository', () => {
  const actual = jest.requireActual('../../infrastructure/ShiftHoursValidationRepository');
  return {
    ...actual,
    ShiftHoursValidationRepository: jest.fn(),
  };
});

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
  durationHours: 4,
};

const SHIFT_SEM_CHECKIN: SourceShiftDTO = {
  ...SHIFT_A,
  sourceShiftId: 'shift-b',
  actualStart: null,
  actualEnd: null,
  checkinSource: null,
  durationHours: null,
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
    it('devolve os pacientes agrupados, sem filtro', async () => {
      const service = new AnaCareHoursService(new StubSource(), mockRepo());
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
      const service = new AnaCareHoursService(new StubSource(shifts), mockRepo());
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
      const service = new AnaCareHoursService(new StubSource(), repo, kms);

      const semCelula = await service.getMonthSnapshot('2026-09', false);
      const shiftSemCelula = semCelula.patients[0].providers[0].shifts.find((s) => s.id === 'shift-a')!;
      expect(shiftSemCelula.contestNote).toBeUndefined();
      expect(decrypt).not.toHaveBeenCalled();

      const comCelula = await service.getMonthSnapshot('2026-09', true);
      const shiftComCelula = comCelula.patients[0].providers[0].shifts.find((s) => s.id === 'shift-a')!;
      expect(shiftComCelula.contestNote).toBe('nota decifrada');
      expect(decrypt).toHaveBeenCalledWith('cifra');
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
  });

  describe('getRetratoStatus', () => {
    it('fase 1: sempre fresco (adapter falso não tem staleness real)', async () => {
      const service = new AnaCareHoursService(new StubSource(), mockRepo());
      const status = await service.getRetratoStatus('2026-09');
      expect(status).toEqual({ updatedAt: expect.any(String), stale: false, circuitBreakerOpen: false });
    });
  });

  describe('validateShift', () => {
    it('turno sem check-in valida com 0h congeladas (D344)', async () => {
      const repo = mockRepo();
      const service = new AnaCareHoursService(new StubSource(), repo);
      await service.validateShift('shift-b', 'uid-1');
      expect(repo.validate).toHaveBeenCalledWith(expect.objectContaining({ sourceShiftId: 'shift-b', approvedHours: 0, validatedBy: 'uid-1' }));
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
