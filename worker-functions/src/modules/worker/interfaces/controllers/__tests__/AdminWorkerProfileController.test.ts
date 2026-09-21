/**
 * AdminWorkerProfileController — spec 025 (Fase 6, D402 item 4): `birthDate` no PATCH
 * /api/admin/workers/:id/profile exige a célula CUMULATIVA `worker_pii:write` (mesmo mecanismo
 * de `patient_clinical:write` em AdminTherapeuticProjectsController).
 *
 * Achado catalogado em T6.1 (`evidencias/t6-1-padrao-celula.md` §Achados fora de escopo): este
 * controller não tinha NENHUM teste que forçasse 403 por célula ausente em campo nenhum — este
 * arquivo é o primeiro caso do endpoint, não só do campo novo.
 *
 * `execute`/`recordFieldChanges` são mockados — o teste é do CONTROLLER (parse + gate + resposta),
 * nunca toca banco/KMS real (isso é coberto por `UpdateWorkerProfileFieldsUseCase.test.ts`).
 */
import type { Request, Response } from 'express';
import { AdminWorkerProfileController } from '../AdminWorkerProfileController';

const executeMock = jest.fn();
const recordFieldChangesMock = jest.fn();

jest.mock('../../../application/UpdateWorkerProfileFieldsUseCase', () => ({
  UpdateWorkerProfileFieldsUseCase: jest.fn().mockImplementation(() => ({ execute: executeMock })),
  WorkerNotFoundError: class WorkerNotFoundError extends Error {},
}));
jest.mock('../../../infrastructure/WorkerAuditRepository', () => ({
  WorkerAuditRepository: jest.fn().mockImplementation(() => ({ recordFieldChanges: recordFieldChangesMock })),
  extractWorkerAuditActor: jest.fn().mockReturnValue({ userId: 'admin-1' }),
}));
jest.mock('@shared/events/PubSubClient', () => ({ PubSubClient: jest.fn() }));
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn() },
  reportError: jest.fn(),
}));

const WORKER_ID = 'a0000000-0000-0000-0000-000000000001';
const VALID_ISO = '1990-05-15'; // sintética, não real — CLAUDE.md §PII

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    params: { id: WORKER_ID },
    body: {},
    user: { uid: 'admin-1' },
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('AdminWorkerProfileController.updateProfile — birthDate atrás de worker_pii:write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    executeMock.mockResolvedValue({ workerId: WORKER_ID, fieldsUpdated: ['birthDate'], changes: [] });
    recordFieldChangesMock.mockResolvedValue(undefined);
  });

  it('com a célula + data ISO válida → 200, grava (useCase.execute chamado com o patch)', async () => {
    const ctrl = new AdminWorkerProfileController();
    const res = mockRes();
    const req = mockReq({ body: { birthDate: VALID_ISO }, permissionCells: ['worker:update', 'worker_pii:write'] });

    await ctrl.updateProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: WORKER_ID, birthDate: VALID_ISO }),
      expect.objectContaining({ source: 'admin_panel' }),
    );
  });

  it.each([
    ['dia inexistente (31/02)', '1990-02-31'],
    ['data futura', '2999-01-01'],
    ['formato errado (DD/MM/AAAA)', '15/05/1990'],
    ['mês inválido', '1990-13-01'],
  ])('com a célula + data inválida (%s) → 400, useCase NUNCA chamado', async (_label, invalidValue) => {
    const ctrl = new AdminWorkerProfileController();
    const res = mockRes();
    const req = mockReq({ body: { birthDate: invalidValue }, permissionCells: ['worker:update', 'worker_pii:write'] });

    await ctrl.updateProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('SEM a célula worker_pii:write → 403 nomeando a célula, valor NUNCA ecoado, useCase NUNCA chamado', async () => {
    const ctrl = new AdminWorkerProfileController();
    const res = mockRes();
    const req = mockReq({ body: { birthDate: VALID_ISO }, permissionCells: ['worker:update'] });

    await ctrl.updateProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Forbidden', details: { cell: 'worker_pii:write' } });
    const jsonCallsAsString = JSON.stringify(res.json.mock.calls);
    expect(jsonCallsAsString).not.toContain(VALID_ISO);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('cells = [] (ator conhecido, sem célula nenhuma) → 403 também', async () => {
    const ctrl = new AdminWorkerProfileController();
    const res = mockRes();
    const req = mockReq({ body: { birthDate: VALID_ISO }, permissionCells: [] });

    await ctrl.updateProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('cells = null (engine não decidiu, D113) → passa, mesmo sem a célula explícita', async () => {
    const ctrl = new AdminWorkerProfileController();
    const res = mockRes();
    const req = mockReq({ body: { birthDate: VALID_ISO }, permissionCells: null });

    await ctrl.updateProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(executeMock).toHaveBeenCalled();
  });

  it('campo birthDate AUSENTE do body → não checa a célula do dossiê e não altera nada relacionado a ela', async () => {
    const ctrl = new AdminWorkerProfileController();
    const res = mockRes();
    const req = mockReq({ body: { firstName: 'Nombre Nuevo' }, permissionCells: ['worker:update'] });

    await ctrl.updateProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(executeMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ birthDate: expect.anything() }),
      expect.anything(),
    );
  });

  it('body vazio ({}) → 400 (mesma regra antiga: pelo menos um campo)', async () => {
    const ctrl = new AdminWorkerProfileController();
    const res = mockRes();
    const req = mockReq({ body: {}, permissionCells: ['worker:update', 'worker_pii:write'] });

    await ctrl.updateProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
