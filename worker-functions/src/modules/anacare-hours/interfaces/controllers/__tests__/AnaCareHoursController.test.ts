/**
 * AnaCareHoursController — `AnaCareHoursService` INJETADO via `serviceFactory` (fronteira mockada,
 * mesmo molde dos outros controllers do repo: unit prova o roteamento HTTP↔service, não o SQL).
 *
 * O bloco "serviceFactory padrão" cobre `defaultServiceFactory` (o único caminho que NÃO recebe
 * injeção) — precisa mockar `DatabaseConnection` na fronteira porque, sem injeção, o service monta
 * o `ShiftHoursValidationRepository` de verdade. O SQL rodando contra Postgres real é provado no
 * e2e (`tests/e2e/anacare-hours-api.e2e.test.ts`), não aqui.
 */
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import type { Request, Response } from 'express';
import { AnaCareHoursController } from '../AnaCareHoursController';
import { AnaCareHoursServiceError } from '../../../domain/AnaCareShift';
import type { AnaCareHoursService } from '../../../application/AnaCareHoursService';

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    permissionCells: null,
    ...overrides,
  } as unknown as Request;
}

function mockService(overrides: Partial<jest.Mocked<AnaCareHoursService>> = {}): jest.Mocked<AnaCareHoursService> {
  return {
    getMonthSnapshot: jest.fn(),
    getPatientMonth: jest.fn(),
    getRetratoStatus: jest.fn(),
    validateShift: jest.fn(),
    validateBatch: jest.fn(),
    contestShift: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<AnaCareHoursService>;
}

describe('AnaCareHoursController', () => {
  describe('serviceFactory padrão (sem injeção) — lê ANACARE_HOURS_SOURCE do process.env', () => {
    const original = process.env.ANACARE_HOURS_SOURCE;
    afterEach(() => {
      if (original === undefined) delete process.env.ANACARE_HOURS_SOURCE;
      else process.env.ANACARE_HOURS_SOURCE = original;
    });

    it('sem a env, 503 fail-closed', async () => {
      delete process.env.ANACARE_HOURS_SOURCE;
      const controller = new AnaCareHoursController();
      const res = mockRes();
      await controller.getMonthSnapshot(mockReq({ params: { month: '2026-09' } }), res);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('com ANACARE_HOURS_SOURCE=fake, monta o adapter falso de verdade e responde 200', async () => {
      process.env.ANACARE_HOURS_SOURCE = 'fake';
      const controller = new AnaCareHoursController();
      const res = mockRes();
      await controller.getMonthSnapshot(mockReq({ params: { month: '2026-09' } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('sem ANACARE_HOURS_SOURCE configurada (serviceFactory devolve null)', () => {
    it('todo endpoint responde 503 ANACARE_SOURCE_NOT_CONFIGURED — fail-closed', async () => {
      const controller = new AnaCareHoursController(() => null);
      const res = mockRes();
      await controller.getMonthSnapshot(mockReq({ params: { month: '2026-09' } }), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ANACARE_SOURCE_NOT_CONFIGURED' }));
    });

    it('getPatientMonth também responde 503', async () => {
      const controller = new AnaCareHoursController(() => null);
      const res = mockRes();
      await controller.getPatientMonth(mockReq({ params: { month: '2026-09', patientId: 'AC-PAT-0' } }), res);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('validateShift também responde 503', async () => {
      const controller = new AnaCareHoursController(() => null);
      const res = mockRes();
      await controller.validateShift(mockReq({ params: { shiftId: 's1' } }), res);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('validateBatch também responde 503', async () => {
      const controller = new AnaCareHoursController(() => null);
      const res = mockRes();
      await controller.validateBatch(mockReq({ body: { shiftIds: ['s1'] } }), res);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('contestShift também responde 503', async () => {
      const controller = new AnaCareHoursController(() => null);
      const res = mockRes();
      await controller.contestShift(mockReq({ params: { shiftId: 's1' }, body: { reason: 'otro' } }), res);
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  describe('getMonthSnapshot', () => {
    it('400 quando o mês é inválido', async () => {
      const controller = new AnaCareHoursController(() => mockService());
      const res = mockRes();
      await controller.getMonthSnapshot(mockReq({ params: { month: 'lixo' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 quando a query tem chave desconhecida com tipo errado (array em vez de string)', async () => {
      const controller = new AnaCareHoursController(() => mockService());
      const res = mockRes();
      await controller.getMonthSnapshot(mockReq({ params: { month: '2026-09' }, query: { patientSearch: ['a', 'b'] as never } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('200 com o snapshot; canReadNote é SEMPRE false no main (sem ABAC/célula, hardcoded — nunca decifra a nota)', async () => {
      const service = mockService({ getMonthSnapshot: jest.fn().mockResolvedValue({ month: '2026-09', patients: [] }) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      // mesmo com `permissionCells` de célula clínica no request (campo que não existe/não é lido
      // no main), o controller NUNCA deve repassar `true` — prova que o hardcode não é decorativo.
      await controller.getMonthSnapshot(mockReq({ params: { month: '2026-09' }, permissionCells: ['patient_clinical:read'] } as never), res);
      expect(service.getMonthSnapshot).toHaveBeenCalledWith('2026-09', false);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { month: '2026-09', patients: [] } });
    });

    it('500 e reportError em erro inesperado (não é AnaCareHoursServiceError)', async () => {
      const service = mockService({ getMonthSnapshot: jest.fn().mockRejectedValue(new Error('boom')) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.getMonthSnapshot(mockReq({ params: { month: '2026-09' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 mesmo quando o que foi lançado não é um Error (string solta)', async () => {
      const service = mockService({ getMonthSnapshot: jest.fn().mockRejectedValue('boom-sem-Error') });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.getMonthSnapshot(mockReq({ params: { month: '2026-09' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('AnaCareHoursServiceError com code desconhecido cai no default 400 (defesa, nunca deveria acontecer com os 4 codes válidos)', async () => {
      const erroDesconhecido = new AnaCareHoursServiceError('TURNO_NAO_ENCONTRADO');
      (erroDesconhecido as { code: string }).code = 'CODE_INEXISTENTE';
      const service = mockService({ getMonthSnapshot: jest.fn().mockRejectedValue(erroDesconhecido) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.getMonthSnapshot(mockReq({ params: { month: '2026-09' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('getPatientMonth', () => {
    it('400 com params inválidos', async () => {
      const controller = new AnaCareHoursController(() => mockService());
      const res = mockRes();
      await controller.getPatientMonth(mockReq({ params: { month: 'lixo', patientId: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 quando o paciente não existe no mês', async () => {
      const service = mockService({ getPatientMonth: jest.fn().mockResolvedValue(null) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.getPatientMonth(mockReq({ params: { month: '2026-09', patientId: 'AC-PAT-0' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 com o paciente', async () => {
      const service = mockService({ getPatientMonth: jest.fn().mockResolvedValue({ anaCareId: 'AC-PAT-0' }) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.getPatientMonth(mockReq({ params: { month: '2026-09', patientId: 'AC-PAT-0' } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('500 em erro inesperado', async () => {
      const service = mockService({ getPatientMonth: jest.fn().mockRejectedValue(new Error('boom')) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.getPatientMonth(mockReq({ params: { month: '2026-09', patientId: 'AC-PAT-0' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('validateShift', () => {
    it('400 com params inválidos (shiftId vazio)', async () => {
      const controller = new AnaCareHoursController(() => mockService());
      const res = mockRes();
      await controller.validateShift(mockReq({ params: { shiftId: '' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('204 no sucesso, usando o uid do authContext', async () => {
      const service = mockService();
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.validateShift(mockReq({ params: { shiftId: 's1' }, authContext: { principal: { id: 'uid-9' } } } as never), res);
      expect(service.validateShift).toHaveBeenCalledWith('s1', 'uid-9');
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('409 quando o service recusa com JA_VALIDADO', async () => {
      const service = mockService({ validateShift: jest.fn().mockRejectedValue(new AnaCareHoursServiceError('JA_VALIDADO')) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.validateShift(mockReq({ params: { shiftId: 's1' } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('404 quando o service recusa com TURNO_NAO_ENCONTRADO', async () => {
      const service = mockService({ validateShift: jest.fn().mockRejectedValue(new AnaCareHoursServiceError('TURNO_NAO_ENCONTRADO')) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.validateShift(mockReq({ params: { shiftId: 's1' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('validateBatch', () => {
    it('400 com body inválido (shiftIds ausente)', async () => {
      const controller = new AnaCareHoursController(() => mockService());
      const res = mockRes();
      await controller.validateBatch(mockReq({ body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('200 com o resultado por item', async () => {
      const results = [{ shiftId: 's1', ok: true }];
      const service = mockService({ validateBatch: jest.fn().mockResolvedValue(results) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.validateBatch(mockReq({ body: { shiftIds: ['s1'] } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { results } });
    });

    it('500 em erro inesperado (validateBatch em si lançou, não um item do lote)', async () => {
      const service = mockService({ validateBatch: jest.fn().mockRejectedValue(new Error('boom')) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.validateBatch(mockReq({ body: { shiftIds: ['s1'] } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('contestShift', () => {
    it('400 com body inválido (reason fora da lista fechada)', async () => {
      const controller = new AnaCareHoursController(() => mockService());
      const res = mockRes();
      await controller.contestShift(mockReq({ params: { shiftId: 's1' }, body: { reason: 'invalido' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 quando o service recusa com NOTA_MUITO_LONGA', async () => {
      const service = mockService({ contestShift: jest.fn().mockRejectedValue(new AnaCareHoursServiceError('NOTA_MUITO_LONGA')) });
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.contestShift(mockReq({ params: { shiftId: 's1' }, body: { reason: 'otro' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('204 no sucesso', async () => {
      const service = mockService();
      const controller = new AnaCareHoursController(() => service);
      const res = mockRes();
      await controller.contestShift(mockReq({ params: { shiftId: 's1' }, body: { reason: 'otro', note: 'nota' } }), res);
      expect(service.contestShift).toHaveBeenCalledWith('s1', 'otro', 'nota');
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });
});
