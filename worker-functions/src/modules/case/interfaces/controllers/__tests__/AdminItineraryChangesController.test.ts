/**
 * AdminItineraryChangesController — C9 (GET .../itinerary/changes). 400 só de forma; serviço
 * inexistente → 404; feliz → 200 { changes }; inesperado → 500 + reportError SEM id de prestador.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdminItineraryChangesController } from '../AdminItineraryChangesController';
import type { ItineraryChangeLogReader } from '../../../infrastructure/ItineraryChangeLogReader';

const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const SERVICE_ID = '22222222-2222-2222-2222-222222222222';

function reqRes(params: Record<string, unknown>): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ params } as unknown as Request, { json, status } as unknown as Response];
}
const jsonOf = (res: Response) => (res as unknown as { json: jest.Mock }).json;

describe('AdminItineraryChangesController.list', () => {
  const reader = { listByService: jest.fn() };
  const ctrl = new AdminItineraryChangesController(reader as unknown as ItineraryChangeLogReader);
  beforeEach(() => jest.clearAllMocks());

  it('params inválidos → 400; o leitor não roda', async () => {
    const [req, res] = reqRes({ id: 'nope', sid: SERVICE_ID });
    await ctrl.list(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(reader.listByService).not.toHaveBeenCalled();
  });

  it('serviço inexistente/de outro paciente (null) → 404 NOT_FOUND', async () => {
    reader.listByService.mockResolvedValueOnce(null);
    const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
    await ctrl.list(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(jsonOf(res)).toHaveBeenCalledWith({ success: false, code: 'NOT_FOUND' });
  });

  it('feliz → 200 { success, data: { changes } }', async () => {
    const changes = [{ id: 'l-1', kind: 'ABSENCE' }];
    reader.listByService.mockResolvedValueOnce(changes);
    const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
    await ctrl.list(req, res);
    expect(reader.listByService).toHaveBeenCalledWith(PATIENT_ID, SERVICE_ID);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: { changes } });
  });

  it('erro inesperado → 500 e reportError { source, patientId, serviceId } sem workerId', async () => {
    reader.listByService.mockRejectedValueOnce(new Error('boom'));
    const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
    await ctrl.list(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    const ctx = (reportError as jest.Mock).mock.calls[0][1];
    expect(ctx).toEqual({ source: 'AdminItineraryChangesController:list', patientId: PATIENT_ID, serviceId: SERVICE_ID });
  });
});
