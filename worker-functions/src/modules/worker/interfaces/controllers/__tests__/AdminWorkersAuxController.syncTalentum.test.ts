/**
 * AdminWorkersAuxController.syncTalentum.test.ts — POST /api/admin/workers/sync-talentum (spec 040 F3).
 *
 * O handler repassa o lote do corpo ({ cursor, maxProjects }) ao use case e devolve o relatório. Em
 * NODE_ENV=test responde 503 antes de tocar a Talentum (sem credencial GCP). O use case é mockado: a lógica
 * do sync é provada em SyncTalentumWorkersUseCase.test.ts.
 */

const mockExecute = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({ KMSEncryptionService: jest.fn() }));
jest.mock('@shared/security/BlindIndexService', () => ({ BlindIndexService: jest.fn() }));
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
  safeErrorFields: jest.fn().mockReturnValue({}),
}));
jest.mock('@modules/integration', () => ({
  SyncTalentumWorkersUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })),
  parseSyncOptions: jest.requireActual('../../../../integration/application/SyncTalentumWorkersUseCase').parseSyncOptions,
}));

import type { Request, Response } from 'express';
import { AdminWorkersAuxController } from '../AdminWorkersAuxController';

function call(body: unknown): [Request, Response] {
  const req = { body } as unknown as Request;
  const res = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response;
  return [req, res];
}

describe('AdminWorkersAuxController.syncTalentumWorkers', () => {
  const controller = new AdminWorkersAuxController();
  const nodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    mockExecute.mockReset();
    jest.spyOn(console, 'error').mockImplementation();
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
    jest.restoreAllMocks();
  });

  it('em NODE_ENV=test responde 503 sem tocar o use case', async () => {
    process.env.NODE_ENV = 'test';
    const [req, res] = call({});

    await controller.syncTalentumWorkers(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('repassa o lote do corpo ao use case e devolve o relatório (200)', async () => {
    mockExecute.mockResolvedValue({ nextCursor: 100 });
    const [req, res] = call({ cursor: 0, maxProjects: 100 });

    await controller.syncTalentumWorkers(req, res);

    expect(mockExecute).toHaveBeenCalledWith({ cursor: 0, maxProjects: 100 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { nextCursor: 100 } });
  });

  it('corpo ausente ou inválido = sem lote (comportamento antigo: lê tudo)', async () => {
    mockExecute.mockResolvedValue({});
    const [req, res] = call(undefined);

    await controller.syncTalentumWorkers(req, res);

    expect(mockExecute).toHaveBeenCalledWith({});
  });

  it('erro da Talentum → 502; qualquer outro → 500', async () => {
    mockExecute.mockRejectedValueOnce(new Error('[TalentumApiClient] GET /projects — HTTP 500'));
    const [req1, res1] = call({});
    await controller.syncTalentumWorkers(req1, res1);
    expect(res1.status).toHaveBeenCalledWith(502);

    mockExecute.mockRejectedValueOnce(new Error('boom'));
    const [req2, res2] = call({});
    await controller.syncTalentumWorkers(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(500);
  });
});
