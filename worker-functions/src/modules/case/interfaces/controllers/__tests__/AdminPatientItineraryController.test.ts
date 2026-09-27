/**
 * AdminPatientItineraryController — fase 7, P7. Use case mockado: a prova end-to-end (banco real,
 * derivação, RLS) é o e2e (P8-P10). Aqui cobrimos validação/erro e o contrato publicado.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import { AdminPatientItineraryController } from '../AdminPatientItineraryController';
import { PatientNotFoundForItineraryError } from '../../../application/GetPatientItineraryUseCase';
import { patientItineraryResponseSchema } from '../../validators/itinerarySchemas';
import { reportError } from '@shared/logging';
import type { Response } from 'express';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const SLOT_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKER_ID = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
const APPLICATION_ID = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

const FELIZ = {
  patientId: PATIENT_ID,
  asOf: '2026-09-27',
  services: [
    {
      contractedServiceId: SERVICE_ID,
      contratadas: { weekly: 20, authorized: null },
      cobertas: 4,
      slots: [
        {
          id: SLOT_ID,
          weekday: 1,
          startTime: '08:00',
          endTime: '12:00',
          active: true,
          assignments: [
            {
              workerId: WORKER_ID,
              applicationId: APPLICATION_ID,
              validFrom: '2026-09-01',
              validTo: null,
              status: 'ACTIVE' as const,
            },
          ],
        },
      ],
    },
  ],
};

/** Varredura recursiva das chaves do corpo — nenhuma pode ser nome/telefone (nem variação de caixa). */
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

describe('AdminPatientItineraryController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('400 quando :id não é UUID', async () => {
      const useCase = { execute: jest.fn() };
      const controller = new AdminPatientItineraryController(useCase as never);
      const res = mockRes();

      await controller.get(mockReq({ params: { id: 'not-a-uuid' } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.execute).not.toHaveBeenCalled();
    });

    it('404 NOT_FOUND quando o caso de uso lança PatientNotFoundForItineraryError', async () => {
      const useCase = { execute: jest.fn().mockRejectedValue(new PatientNotFoundForItineraryError(PATIENT_ID)) };
      const controller = new AdminPatientItineraryController(useCase as never);
      const res = mockRes();

      await controller.get(mockReq({ params: { id: PATIENT_ID } }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, code: 'NOT_FOUND' });
    });

    it('500 e reportError com { source, patientId } e nada mais (nunca o corpo/erro cru)', async () => {
      const useCase = { execute: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientItineraryController(useCase as never);
      const res = mockRes();

      await controller.get(mockReq({ params: { id: PATIENT_ID } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminPatientItineraryController:get', patientId: PATIENT_ID });
    });

    it('500 quando o caso de uso rejeita com algo que NÃO é Error (String(err) no reportError)', async () => {
      const useCase = { execute: jest.fn().mockRejectedValue('rejeição crua') };
      const controller = new AdminPatientItineraryController(useCase as never);
      const res = mockRes();

      await controller.get(mockReq({ params: { id: PATIENT_ID } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('200, o corpo satisfaz o contrato publicado (patientItineraryResponseSchema) e não tem name/phone', async () => {
      const useCase = { execute: jest.fn().mockResolvedValue(FELIZ) };
      const controller = new AdminPatientItineraryController(useCase as never);
      const res = mockRes();

      await controller.get(mockReq({ params: { id: PATIENT_ID } }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(() => patientItineraryResponseSchema.parse(body.data)).not.toThrow();
      expect(chavesProibidas(body, /name|phone/i)).toEqual([]);
    });
  });
});
