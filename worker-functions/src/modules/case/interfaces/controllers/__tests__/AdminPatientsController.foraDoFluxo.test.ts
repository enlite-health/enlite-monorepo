/**
 * Spec 051 (F2) — o controller do PUT /:id/status na troca fora do fluxo:
 *   - passa as células do ator ao serviço (`null` continua `null`, nunca `[]`) — SÓ ele passa;
 *   - `PatientStatusPermissionError` → 403 `{code, details:{from,to,cell}}`;
 *   - corpo com `changeSource: '*_override'` → 400 (o cliente não se declara override).
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
import { AdminPatientsController } from '../AdminPatientsController';
import type { PatientService } from '../../../application/PatientService';
import { PatientStatusPermissionError } from '../../../application/PatientStatusWriter';
import type { CreatePatientUseCase } from '../../../application/CreatePatientUseCase';

const ID = '11111111-1111-4111-8111-111111111111';

function reqRes(body: Record<string, unknown>, extra: Record<string, unknown> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ params: { id: ID }, body, query: {}, ...extra } as unknown as Request, { json, status } as unknown as Response];
}
const bodyOf = (res: Response) => ((res as unknown as { status: jest.Mock }).status.mock.results[0].value.json as jest.Mock).mock.calls[0][0];
const ctrlCom = (moveStatus: jest.Mock) =>
  new AdminPatientsController(undefined, { execute: jest.fn() } as unknown as CreatePatientUseCase, { moveStatus, updatePatientSection: jest.fn() } as unknown as PatientService);

describe('AdminPatientsController.updatePatientStatus — troca fora do fluxo (spec 051)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('as células do ator viajam ao serviço: [] continua [] e a ausência continua null (nunca `?? []`)', async () => {
    const moveStatus = jest.fn().mockResolvedValue({ id: ID, status: 'SEARCHING' });
    const ctrl = ctrlCom(moveStatus);
    const cells = ['patient:update', 'patient_status:move_to_searching'];
    await ctrl.updatePatientStatus(...reqRes({ status: 'SEARCHING' }, { permissionCells: cells }));
    await ctrl.updatePatientStatus(...reqRes({ status: 'SEARCHING' }, { permissionCells: [] }));
    await ctrl.updatePatientStatus(...reqRes({ status: 'SEARCHING' }));
    expect(moveStatus.mock.calls.map((c) => c[2].cells)).toEqual([cells, [], null]);
  });

  it('PatientStatusPermissionError → 403 com code e details {from,to,cell}', async () => {
    const moveStatus = jest.fn().mockRejectedValue(new PatientStatusPermissionError('ACTIVE', 'SEARCHING', 'patient_status:move_to_searching'));
    const [req, res] = reqRes({ status: 'SEARCHING' }, { permissionCells: ['patient:update'] });
    await ctrlCom(moveStatus).updatePatientStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(bodyOf(res)).toMatchObject({
      success: false, code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED',
      details: { from: 'ACTIVE', to: 'SEARCHING', cell: 'patient_status:move_to_searching' },
    });
  });

  it.each(['admin_panel_override', 'kanban_override'])('corpo com changeSource "%s" → 400 e o serviço não é chamado', async (changeSource) => {
    const moveStatus = jest.fn();
    const [req, res] = reqRes({ status: 'SEARCHING', changeSource }, { permissionCells: ['patient_status:move_to_searching'] });
    await ctrlCom(moveStatus).updatePatientStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(moveStatus).not.toHaveBeenCalled();
  });

  it('destino fora do vocabulário → 400 (A4-i)', async () => {
    const moveStatus = jest.fn();
    const [req, res] = reqRes({ status: 'DISCONTINUED' }, { permissionCells: [] });
    await ctrlCom(moveStatus).updatePatientStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(moveStatus).not.toHaveBeenCalled();
  });

  it('paciente deletado/inexistente → 404 (A4-h)', async () => {
    const moveStatus = jest.fn().mockRejectedValue(new Error(`Patient not found: ${ID}`));
    const [req, res] = reqRes({ status: 'SEARCHING' }, { permissionCells: ['patient_status:move_to_searching'] });
    await ctrlCom(moveStatus).updatePatientStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('onHoldNote sem a célula de leitura clínica → 403 de campo e o serviço não é chamado (A4-g), mesmo com a célula do destino', async () => {
    const moveStatus = jest.fn();
    const [req, res] = reqRes({ status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: 'x' }, { permissionCells: ['patient_status:move_to_on_hold'] });
    await ctrlCom(moveStatus).updatePatientStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(bodyOf(res).details).toEqual({ field: 'onHoldNote', cell: 'patient_clinical:read' });
    expect(moveStatus).not.toHaveBeenCalled();
  });
});
