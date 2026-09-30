/**
 * AdminPatientItineraryController — fase 7, P7. Use case mockado: a prova end-to-end (banco real,
 * derivação, RLS) é o e2e (P8-P10). Aqui cobrimos validação/erro e o contrato publicado.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));
jest.mock('@shared/audit/contactAccessFromRequest', () => ({ emitirTrilhaDeContato: jest.fn() }));

import { AdminPatientItineraryController } from '../AdminPatientItineraryController';
import { PatientNotFoundForItineraryError } from '../../../application/GetPatientItineraryUseCase';
import { patientItineraryResponseSchema } from '../../validators/itinerarySchemas';
import { reportError } from '@shared/logging';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import type { Response } from 'express';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const SLOT_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKER_ID = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
const APPLICATION_ID = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee';
const ALLOCATION_ID = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
const OLD_ALLOCATION_ID = 'ffffffff-aaaa-cccc-dddd-eeeeeeeeeeee';
const OLD_WORKER_ID = 'dddddddd-aaaa-cccc-dddd-eeeeeeeeeeee';

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
  assembledAt: null as string | null,
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
              allocationId: ALLOCATION_ID,
              displayName: 'Nombre Qa' as string | null,
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
      // A-contrato (DX-12.16): o nome do prestador vigente passa a sair (`displayName`); telefone, nunca.
      expect(chavesProibidas(body, /phone/i)).toEqual([]);
      expect(body.data.services[0].slots[0].assignments[0].displayName).toBe('Nombre Qa');
    });

    it('[Fase 3] o corpo carrega assembledAt: null sem montagem e a data ISO com montagem; sem o campo o contrato recusa', async () => {
      const respostaCom = async (assembledAt: string | null) => {
        const useCase = { execute: jest.fn().mockResolvedValue({ ...FELIZ, assembledAt }) };
        const res = mockRes();
        await new AdminPatientItineraryController(useCase as never).get(mockReq({ params: { id: PATIENT_ID } }), res);
        return res.json.mock.calls[0][0].data;
      };

      const semMontagem = await respostaCom(null);
      expect(semMontagem.assembledAt).toBeNull();
      expect(patientItineraryResponseSchema.parse(semMontagem).assembledAt).toBeNull();

      const montado = await respostaCom('2026-09-30T18:05:09.123Z');
      expect(montado.assembledAt).toBe('2026-09-30T18:05:09.123Z');
      expect(patientItineraryResponseSchema.parse(montado).assembledAt).toBe('2026-09-30T18:05:09.123Z');

      const { assembledAt: _omitido, ...semCampo } = FELIZ;
      expect(() => patientItineraryResponseSchema.parse(semCampo)).toThrow();
    });

    it('[12.10] passa id, relógio e as células ao caso de uso; a trilha recebe só os workerId com nome', async () => {
      const comHistorico = {
        ...FELIZ,
        services: [
          {
            ...FELIZ.services[0],
            slots: [
              {
                ...FELIZ.services[0].slots[0],
                assignments: [
                  {
                    workerId: OLD_WORKER_ID, applicationId: APPLICATION_ID, validFrom: '2026-01-01', validTo: '2026-06-30',
                    status: 'ENDED' as const, allocationId: OLD_ALLOCATION_ID, displayName: null,
                  },
                  ...FELIZ.services[0].slots[0].assignments,
                ],
              },
              { ...FELIZ.services[0].slots[0], id: SERVICE_ID },
            ],
          },
        ],
      };
      const useCase = { execute: jest.fn().mockResolvedValue(comHistorico) };
      const controller = new AdminPatientItineraryController(useCase as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID }, permissionCells: ['patient_services:read', 'worker_contact:read'] });

      await controller.get(req, res);

      console.log('[12.10]', 'status', res.status.mock.calls[0][0], 'trilha', (emitirTrilhaDeContato as jest.Mock).mock.calls[0][1].length);
      expect(useCase.execute).toHaveBeenCalledWith(PATIENT_ID, expect.any(Date), ['patient_services:read', 'worker_contact:read']);
      expect(emitirTrilhaDeContato).toHaveBeenCalledTimes(1);
      expect(emitirTrilhaDeContato).toHaveBeenCalledWith(req, [WORKER_ID]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('[12.10] sem req.permissionCells (engine OFF) → cells null; nenhum nome → trilha com lista vazia', async () => {
      const semNome = {
        ...FELIZ,
        services: [
          {
            ...FELIZ.services[0],
            slots: [
              {
                ...FELIZ.services[0].slots[0],
                assignments: [{ ...FELIZ.services[0].slots[0].assignments[0], displayName: null }],
              },
            ],
          },
        ],
      };
      const useCase = { execute: jest.fn().mockResolvedValue(semNome) };
      const controller = new AdminPatientItineraryController(useCase as never);
      const res = mockRes();

      await controller.get(mockReq({ params: { id: PATIENT_ID } }), res);

      expect(useCase.execute).toHaveBeenCalledWith(PATIENT_ID, expect.any(Date), null);
      expect((emitirTrilhaDeContato as jest.Mock).mock.calls[0][1]).toEqual([]);
    });
  });
});
