/**
 * AdminPatientKanbanServicesController — fase 8, P5. Use case mockado: a prova end-to-end (banco
 * real, agregação, RLS) é o e2e do backend (P7). Aqui cobrimos validação/erro e o contrato
 * publicado (critério 5: varredura recursiva de chaves, nenhuma casa dado pessoal/clínico).
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import { AdminPatientKanbanServicesController } from '../AdminPatientKanbanServicesController';
import { kanbanServicesResponseSchema } from '../../validators/kanbanServicesSchemas';
import { reportError } from '@shared/logging';
import type { Response } from 'express';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const VACANCY_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(overrides: Record<string, unknown> = {}) {
  return { query: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

const FELIZ = {
  patients: [
    {
      patientId: PATIENT_ID,
      asOf: '2026-09-27',
      services: [
        {
          contractedServiceId: SERVICE_ID,
          serviceCode: 'AT',
          contratadas: { weekly: 20, authorized: null },
          cobertas: 4,
          liveVacancyId: VACANCY_ID,
        },
      ],
    },
  ],
};

/** Varredura recursiva das chaves do corpo — nenhuma pode ser dado pessoal/clínico (critério 5). */
function chavesProibidas(value: unknown, proibido: RegExp): string[] {
  const achadas: string[] = [];
  const visitar = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(visitar);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [chave, filho] of Object.entries(v)) {
        if (proibido.test(chave)) achadas.push(chave);
        visitar(filho);
      }
    }
  };
  visitar(value);
  return achadas;
}

describe('AdminPatientKanbanServicesController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('list', () => {
    it('400 quando country não é AR/BR', async () => {
      const useCase = { execute: jest.fn() };
      const controller = new AdminPatientKanbanServicesController(useCase as never);
      const res = mockRes();

      await controller.list(mockReq({ query: { country: 'XX' } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.execute).not.toHaveBeenCalled();
    });

    it('sem country → useCase.execute(null)', async () => {
      const useCase = { execute: jest.fn().mockResolvedValue({ patients: [] }) };
      const controller = new AdminPatientKanbanServicesController(useCase as never);
      const res = mockRes();

      await controller.list(mockReq(), res);

      expect(useCase.execute).toHaveBeenCalledWith(null);
    });

    it('country=AR → useCase.execute("AR")', async () => {
      const useCase = { execute: jest.fn().mockResolvedValue({ patients: [] }) };
      const controller = new AdminPatientKanbanServicesController(useCase as never);
      const res = mockRes();

      await controller.list(mockReq({ query: { country: 'AR' } }), res);

      expect(useCase.execute).toHaveBeenCalledWith('AR');
    });

    it('500 e reportError com { source, country } e nada mais (nunca o corpo/erro cru)', async () => {
      const useCase = { execute: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientKanbanServicesController(useCase as never);
      const res = mockRes();

      await controller.list(mockReq({ query: { country: 'BR' } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminPatientKanbanServicesController:list',
        country: 'BR',
      });
    });

    it('500 quando o caso de uso rejeita com algo que NÃO é Error (String(err) no reportError)', async () => {
      const useCase = { execute: jest.fn().mockRejectedValue('rejeição crua') };
      const controller = new AdminPatientKanbanServicesController(useCase as never);
      const res = mockRes();

      await controller.list(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('200, o corpo satisfaz o contrato publicado (kanbanServicesResponseSchema) e não tem dado pessoal/clínico', async () => {
      const useCase = { execute: jest.fn().mockResolvedValue(FELIZ) };
      const controller = new AdminPatientKanbanServicesController(useCase as never);
      const res = mockRes();

      await controller.list(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(() => kanbanServicesResponseSchema.parse(body.data)).not.toThrow();
      expect(chavesProibidas(body, /diagnos|clinic|name|phone|email|document|address/i)).toEqual([]);
    });
  });
});
