/**
 * Spec 051 (F3) — o controller do GET /:id/status-options: 400 / 404 / 500 / 200, e as células do
 * ator chegam ao serviço como vieram (`null` continua `null`, nunca `[]`).
 */
jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
}));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: jest.fn(), connect: jest.fn() }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: jest.fn(), decrypt: jest.fn() })),
}));
jest.mock('../../../infrastructure/PatientQueryRepository', () => ({
  PatientQueryRepository: jest.fn().mockImplementation(() => ({ findDetailById: jest.fn(), list: jest.fn(), stats: jest.fn() })),
}));
jest.mock('@modules/matching', () => ({ buildInsertQuery: jest.fn(), buildInsertParams: jest.fn() }));
jest.mock('../../../infrastructure/PatientStatusHistoryQueryHelper', () => ({ fetchPatientStatusHistory: jest.fn() }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdminPatientsController } from '../AdminPatientsController';
import type { PatientService } from '../../../application/PatientService';
import type { CreatePatientUseCase } from '../../../application/CreatePatientUseCase';

const ID = '11111111-1111-4111-8111-111111111111';

function reqRes(params: Record<string, unknown>, extra: Record<string, unknown> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ params, body: {}, query: {}, ...extra } as unknown as Request, { json, status } as unknown as Response];
}
const bodyOf = (res: Response) => ((res as unknown as { status: jest.Mock }).status.mock.results[0].value.json as jest.Mock).mock.calls[0][0];
const ctrlCom = (statusOptions: jest.Mock) =>
  new AdminPatientsController(undefined, { execute: jest.fn() } as unknown as CreatePatientUseCase, { statusOptions } as unknown as PatientService);

describe('AdminPatientsController.getPatientStatusOptions (spec 051, F3)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('200 {success, data:{current, options}} e as células viajam como vieram ([] continua [], ausente continua null)', async () => {
    const data = { current: 'ACTIVE', options: [{ status: 'SEARCHING', via: 'permissao' }, { status: 'ON_HOLD', via: 'fluxo' }] };
    const statusOptions = jest.fn().mockResolvedValue(data);
    const ctrl = ctrlCom(statusOptions);
    const [req, res] = reqRes({ id: ID }, { permissionCells: ['patient:update', 'patient_status:move_to_searching'] });
    await ctrl.getPatientStatusOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(bodyOf(res)).toEqual({ success: true, data });
    await ctrl.getPatientStatusOptions(...reqRes({ id: ID }, { permissionCells: [] }));
    await ctrl.getPatientStatusOptions(...reqRes({ id: ID }));
    expect(statusOptions.mock.calls.map((c) => c[1])).toEqual([['patient:update', 'patient_status:move_to_searching'], [], null]);
  });

  it('?changeSource: ausente = admin_panel; kanban e admin_panel viajam ao serviço', async () => {
    const statusOptions = jest.fn().mockResolvedValue({ current: 'ADMISSION', changeSource: 'kanban', options: [] });
    const ctrl = ctrlCom(statusOptions);
    await ctrl.getPatientStatusOptions(...reqRes({ id: ID }));
    await ctrl.getPatientStatusOptions(...reqRes({ id: ID }, { query: { changeSource: 'kanban' } }));
    await ctrl.getPatientStatusOptions(...reqRes({ id: ID }, { query: { changeSource: 'admin_panel' } }));
    expect(statusOptions.mock.calls.map((c) => c[2])).toEqual(['admin_panel', 'kanban', 'admin_panel']);
  });

  it.each(['system', 'admin_panel_override', 'kanban_override', 'qualquer'])('?changeSource=%s → 400 e o serviço não é chamado', async (valor) => {
    const statusOptions = jest.fn();
    const [req, res] = reqRes({ id: ID }, { query: { changeSource: valor } });
    await ctrlCom(statusOptions).getPatientStatusOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(statusOptions).not.toHaveBeenCalled();
  });

  it('id inválido → 400 e o serviço não é chamado', async () => {
    const statusOptions = jest.fn();
    const [req, res] = reqRes({ id: 'nao-e-uuid' });
    await ctrlCom(statusOptions).getPatientStatusOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(statusOptions).not.toHaveBeenCalled();
  });

  it('paciente inexistente/deletado → 404', async () => {
    const [req, res] = reqRes({ id: ID });
    await ctrlCom(jest.fn().mockRejectedValue(new Error(`Patient not found: ${ID}`))).getPatientStatusOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('rejeição que não é Error (string) → 500 também', async () => {
    const [req, res] = reqRes({ id: ID });
    await ctrlCom(jest.fn().mockRejectedValue('texto cru')).getPatientStatusOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('erro inesperado → 500 e reportError', async () => {
    const [req, res] = reqRes({ id: ID });
    await ctrlCom(jest.fn().mockRejectedValue(new Error('boom'))).getPatientStatusOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalled();
  });
});
