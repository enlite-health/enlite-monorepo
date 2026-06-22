/**
 * AdminWorkerTestFlagController.test.ts
 *
 * Testes unitários para PATCH /api/admin/workers/:id/test-flag.
 *
 * Cenários cobertos:
 *   1. Happy path — marca worker como conta de teste (200 + { isTest })
 *   2. Happy path — desmarca (isTest: false)
 *   3. 400 — body inválido (isTest ausente)
 *   4. 400 — body inválido (isTest não-booleano)
 *   5. 401 — sem uid no request
 *   6. 404 — worker inexistente (UPDATE retorna 0 linhas)
 *   7. 500 — erro de banco
 */

const mockQuery = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@shared/security/BlindIndexService', () => ({
  BlindIndexService: jest.fn().mockImplementation(() => ({})),
}));

import { AdminWorkerTestFlagController } from '../AdminWorkerTestFlagController';
import { Request, Response } from 'express';

const WORKER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReqRes(body: unknown, withUid = true): [Request, Response] {
  const req = {
    params: { id: WORKER_ID },
    body,
    user: withUid ? { uid: 'admin-uid' } : undefined,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('AdminWorkerTestFlagController.updateTestFlag', () => {
  let controller: AdminWorkerTestFlagController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminWorkerTestFlagController();
  });

  it('marks a worker as test account (200)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ is_test: true }] });
    const [req, res] = mockReqRes({ isTest: true });

    await controller.updateTestFlag(req, res);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE workers SET is_test = $2'),
      [WORKER_ID, true],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { isTest: true } });
  });

  it('unmarks a worker (isTest: false)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ is_test: false }] });
    const [req, res] = mockReqRes({ isTest: false });

    await controller.updateTestFlag(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { isTest: false } });
  });

  it('returns 400 when isTest is missing', async () => {
    const [req, res] = mockReqRes({});
    await controller.updateTestFlag(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when isTest is not a boolean', async () => {
    const [req, res] = mockReqRes({ isTest: 'yes' });
    await controller.updateTestFlag(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated uid', async () => {
    const [req, res] = mockReqRes({ isTest: true }, false);
    await controller.updateTestFlag(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when the worker does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({ isTest: true });

    await controller.updateTestFlag(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Worker not found' });
  });

  it('returns 500 on database error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const [req, res] = mockReqRes({ isTest: true });

    await controller.updateTestFlag(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
